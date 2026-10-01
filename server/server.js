import http from "node:http";
import crypto from "node:crypto";
import sharp from "sharp";
import SftpClient from "ssh2-sftp-client";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const HOSTINGER_SFTP_HOST = process.env.HOSTINGER_SFTP_HOST || "";
const HOSTINGER_SFTP_PORT = Number(process.env.HOSTINGER_SFTP_PORT || 22);
const HOSTINGER_SFTP_USER = process.env.HOSTINGER_SFTP_USER || "";
const HOSTINGER_SFTP_PRIVATE_KEY = (process.env.HOSTINGER_SFTP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const HOSTINGER_SFTP_DIR = process.env.HOSTINGER_SFTP_DIR || "";
const HOSTINGER_SCREENSHOT_BASE_URL = (process.env.HOSTINGER_SCREENSHOT_BASE_URL || "").replace(/\/$/, "");
if (!BRIDGE_TOKEN) console.warn("WARNING: BRIDGE_TOKEN is not set.");

let browserSocket = null;
let browserConnectedAt = null;
let desktopSocket = null;
let desktopConnectedAt = null;
const pending = new Map();
const desktopPending = new Map();
const wss = new WebSocketServer({ noServer: true });
let sftpClient = null;
let sftpConnectPromise = null;
let lastSftpCleanupAt = 0;

function sftpConfigured() {
  return !!(
    HOSTINGER_SFTP_HOST &&
    HOSTINGER_SFTP_USER &&
    HOSTINGER_SFTP_PRIVATE_KEY &&
    HOSTINGER_SFTP_DIR &&
    HOSTINGER_SCREENSHOT_BASE_URL
  );
}

async function getSftpClient() {
  if (!sftpConfigured()) throw new Error("Hostinger SFTP sharing is not configured.");
  if (sftpClient) return sftpClient;
  if (sftpConnectPromise) return sftpConnectPromise;

  sftpConnectPromise = (async () => {
    const client = new SftpClient();
    await client.connect({
      host: HOSTINGER_SFTP_HOST,
      port: HOSTINGER_SFTP_PORT,
      username: HOSTINGER_SFTP_USER,
      privateKey: HOSTINGER_SFTP_PRIVATE_KEY,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3
    });
    await client.mkdir(HOSTINGER_SFTP_DIR, true);
    sftpClient = client;
    client.on?.("error", () => { sftpClient = null; });
    client.on?.("end", () => { sftpClient = null; });
    client.on?.("close", () => { sftpClient = null; });
    return client;
  })();

  try {
    return await sftpConnectPromise;
  } finally {
    sftpConnectPromise = null;
  }
}

async function uploadScreenshot(buffer, monitorNumber) {
  const client = await getSftpClient();
  const name = `m${monitorNumber}-${Date.now()}-${crypto.randomBytes(10).toString("hex")}.webp`;
  const remotePath = `${HOSTINGER_SFTP_DIR}/${name}`;

  try {
    await client.put(buffer, remotePath);

    const now = Date.now();
    if (now - lastSftpCleanupAt > 300000) {
      lastSftpCleanupAt = now;
      void (async () => {
        try {
          const list = await client.list(HOSTINGER_SFTP_DIR);
          const cutoff = Date.now() - 10 * 60 * 1000;
          await Promise.all(
            list
              .filter(x => x.type === "-" && /^m\d+-\d+-[a-f0-9]+\.webp$/i.test(x.name))
              .filter(x => (x.modifyTime || 0) < cutoff)
              .map(x => client.delete(`${HOSTINGER_SFTP_DIR}/${x.name}`, true))
          );
        } catch {}
      })();
    }

    return `${HOSTINGER_SCREENSHOT_BASE_URL}/${encodeURIComponent(name)}`;
  } catch (err) {
    try { await client.end(); } catch {}
    sftpClient = null;
    throw err;
  }
}

function callBrowser(command, args = {}, timeoutMs = 20000) {
  if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
    throw new Error("Comet extension is not connected to the Railway bridge.");
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for browser command: ${command}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, socket:browserSocket });
    browserSocket.send(JSON.stringify({ type: "command", id, command, args }));
  });
}

function callDesktop(command, args = {}, timeoutMs = 30000) {
  if (!desktopSocket || desktopSocket.readyState !== WebSocket.OPEN) {
    throw new Error("Windows desktop agent is not connected to the Railway bridge.");
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      desktopPending.delete(id);
      reject(new Error(`Timed out waiting for desktop command: ${command}`));
    }, timeoutMs);
    desktopPending.set(id, { resolve, reject, timer, socket:desktopSocket });
    desktopSocket.send(JSON.stringify({ type: "command", id, command, args }));
  });
}

function makeMcpServer() {
  const server = new McpServer({ name: "gpt-us-browser-desktop", version: "0.7.17" });

  server.registerTool("get_page", {
    description: "Read the active Comet tab: title, URL, visible text, and interactive elements.",
    inputSchema: z.object({ maxChars: z.number().int().min(1000).max(100000).optional() })
  }, async ({ maxChars }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("get_page", { maxChars }), null, 2) }] }));

  server.registerTool("click", {
    description: "Click by CSS selector or visible text, with deep DOM fallback across open Shadow DOM and same-origin frames.",
    inputSchema: z.object({ selector: z.string().optional(), text: z.string().optional() })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("click", args), null, 2) }] }));

  server.registerTool("type", {
    description: "Type text into an editable element selected by CSS selector.",
    inputSchema: z.object({ selector: z.string(), text: z.string(), clearFirst: z.boolean().optional() })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("type", args), null, 2) }] }));

  server.registerTool("navigate", {
    description: "Navigate the active Comet tab to a URL.",
    inputSchema: z.object({ url: z.url() })
  }, async ({ url }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("navigate", { url }), null, 2) }] }));

  server.registerTool("screenshot", {
    description: "Capture each Windows monitor separately. Returns a compact image for ChatGPT vision and, when Hostinger SFTP is configured, a shareable temporary URL for each monitor.",
    inputSchema: z.object({})
  }, async () => {
    const monitors = await callDesktop("desktop_monitors", {}, 30000);
    if (!Array.isArray(monitors) || monitors.length === 0) {
      throw new Error("Desktop agent did not return any monitors");
    }

    const content = [];

    for (const monitor of monitors) {
      const screenIndex = Number(monitor.index);
      if (!Number.isInteger(screenIndex) || screenIndex < 0) continue;

      const shot = await callDesktop("desktop_screenshot", { screen: screenIndex }, 30000);
      if (!shot?.data) continue;

      const source = Buffer.from(String(shot.data), "base64");

      const modelCopy = await sharp(source)
        .resize({ width: 1100, withoutEnlargement: true })
        .webp({ quality: 45, effort: 4 })
        .toBuffer();

      const shareCopy = await sharp(source)
        .resize({ width: 1800, withoutEnlargement: true })
        .webp({ quality: 68, effort: 4 })
        .toBuffer();

      let shareUrl = null;
      let shareError = null;
      if (sftpConfigured()) {
        try {
          shareUrl = await uploadScreenshot(shareCopy, screenIndex + 1);
        } catch (e) {
          shareError = e?.message || String(e);
        }
      }

      const meta = {
        screenshot: true,
        monitor: screenIndex + 1,
        screen: screenIndex,
        primary: !!monitor.primary,
        monitorName: monitor.name || null,
        x: shot.x ?? monitor.x,
        y: shot.y ?? monitor.y,
        sourceWidth: shot.width ?? monitor.width,
        sourceHeight: shot.height ?? monitor.height,
        modelBytes: modelCopy.length,
        shareBytes: shareCopy.length,
        shareUrl,
        shareError
      };

      content.push({ type: "text", text: JSON.stringify(meta) });
      content.push({
        type: "image",
        data: modelCopy.toString("base64"),
        mimeType: "image/webp"
      });

      if (shareUrl) {
        content.push({
          type: "resource_link",
          uri: shareUrl,
          name: `Monitor ${screenIndex + 1} screenshot`,
          description: `Temporary shared screenshot for monitor ${screenIndex + 1}`,
          mimeType: "image/webp"
        });
      }
    }

    if (!content.some(item => item.type === "image")) {
      throw new Error("Desktop agent did not return any monitor screenshots");
    }

    return { content };
  });

  server.registerTool("move_mouse", {
    description: "Move the visible virtual cursor to viewport coordinates without clicking.",
    inputSchema: z.object({ x: z.number(), y: z.number() })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("move_mouse", args), null, 2) }] }));

  server.registerTool("click_at", {
    description: "Click the element at viewport x/y coordinates. Useful after inspecting a screenshot.",
    inputSchema: z.object({ x: z.number(), y: z.number() })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("click_at", args), null, 2) }] }));

  server.registerTool("inspect_form", {
    description: "Inspect editable fields on the active page, including labels, names, types, options and positions.",
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("inspect_form"), null, 2) }] }));

  server.registerTool("fill_form", {
    description: "Fill many form fields in one fast browser round-trip.",
    inputSchema: z.object({ fields: z.array(z.object({ selector:z.string().optional(), name:z.string().optional(), id:z.string().optional(), index:z.number().int().optional(), value:z.union([z.string(),z.number(),z.boolean()]) })).min(1).max(200) })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("fill_form", args), null, 2) }] }));

  server.registerTool("press_key", {
    description: "Send a keyboard key to the active element or a CSS-selected element.",
    inputSchema: z.object({ key:z.string().min(1), selector:z.string().optional() })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("press_key", args), null, 2) }] }));

  server.registerTool("batch_actions", {
    description: "Execute browser OR Windows desktop commands sequentially. DESKTOP COMMANDS SUPPORTED HERE: desktop_info, desktop_monitors, desktop_screen_size, desktop_screenshot, desktop_move_mouse, desktop_click, desktop_scroll, desktop_mouse_path, desktop_type_text, desktop_key_combo, desktop_clipboard_get/set, desktop_windows/window_*, desktop_processes, desktop_system_info, desktop_file_*, desktop_create_folder, desktop_open_path. Any command beginning desktop_ is routed to the connected Windows Desktop Bridge; other commands go to Comet. This tool is the compatibility path when separate desktop_* tools are not shown by the client.",
    inputSchema: z.object({ actions:z.array(z.object({ command:z.string(), args:z.record(z.string(),z.any()).optional() })).min(1).max(50) })
  }, async ({ actions }) => {
    // Preserve the extension's fast native batching when every action is a browser action.
    if (actions.every(a => !a.command.startsWith("desktop_"))) {
      return { content: [{ type: "text", text: JSON.stringify(await callBrowser("batch_actions", { actions }, 60000), null, 2) }] };
    }
    const results = [];
    for (const a of actions) {
      try {
        const result = a.command.startsWith("desktop_")
          ? await callDesktop(a.command, a.args || {}, 30000)
          : await callBrowser(a.command, a.args || {}, 30000);
        results.push({ ok:true, command:a.command, result });
      } catch (e) {
        results.push({ ok:false, command:a.command, error:e?.message || String(e) });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ completed:true, count:results.length, results }, null, 2) }] };
  });

  server.registerTool("list_tabs", {
    description: "List tabs in the current Comet window.",
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("list_tabs"), null, 2) }] }));

  server.registerTool("activate_tab", {
    description: "Activate a Comet tab by tab ID.",
    inputSchema: z.object({ tabId: z.number().int() })
  }, async ({ tabId }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("activate_tab", { tabId }), null, 2) }] }));

  server.registerTool("new_tab", { description: "Open a new Comet tab.", inputSchema: z.object({ url: z.url().optional(), active: z.boolean().optional() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("new_tab", args), null, 2) }] }));
  server.registerTool("close_tab", { description: "Close a tab; defaults to the active tab.", inputSchema: z.object({ tabId: z.number().int().optional() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("close_tab", args), null, 2) }] }));
  server.registerTool("duplicate_tab", { description: "Duplicate a tab; defaults to the active tab.", inputSchema: z.object({ tabId: z.number().int().optional() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("duplicate_tab", args), null, 2) }] }));
  server.registerTool("reload", { description: "Reload the active tab.", inputSchema: z.object({ bypassCache: z.boolean().optional() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("reload", args), null, 2) }] }));
  server.registerTool("go_back", { description: "Go back in the active tab history.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("go_back"), null, 2) }] }));
  server.registerTool("go_forward", { description: "Go forward in the active tab history.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("go_forward"), null, 2) }] }));
  server.registerTool("scroll", { description: "Scroll the active page by x/y pixels.", inputSchema: z.object({ x: z.number().optional(), y: z.number().optional(), behavior: z.enum(["auto","smooth"]).optional() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("scroll", args), null, 2) }] }));
  server.registerTool("hover", { description: "Hover an element by CSS selector or visible text.", inputSchema: z.object({ selector: z.string().optional(), text: z.string().optional() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("hover", args), null, 2) }] }));
  server.registerTool("select", { description: "Choose a value in a select element.", inputSchema: z.object({ selector: z.string(), value: z.string() }) },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("select", args), null, 2) }] }));


  const optTabId = z.number().int().optional();
  const textResult = async (command,args={},timeout=20000) => ({ content:[{type:"text",text:JSON.stringify(await callBrowser(command,args,timeout),null,2)}] });

  server.registerTool("bridge_info",{description:"Report extension capabilities and connection state.",inputSchema:z.object({})},async()=>textResult("bridge_info"));
  server.registerTool("get_viewport",{description:"Get viewport size, DPR, scroll position and document dimensions.",inputSchema:z.object({tabId:optTabId})},async args=>textResult("get_viewport",args));
  server.registerTool("element_map",{description:"Map interactive elements with bridge IDs and rectangles, including open Shadow DOM and same-origin frames.",inputSchema:z.object({tabId:optTabId})},async args=>textResult("element_map",args));
  server.registerTool("dom_watch",{description:"Capture page state and report whether it changed.",inputSchema:z.object({tabId:optTabId,maxChars:z.number().int().min(1000).max(100000).optional()})},async args=>textResult("dom_watch",args));
  server.registerTool("dom_diff",{description:"Return compact changes since the previous page baseline.",inputSchema:z.object({tabId:optTabId,maxChars:z.number().int().min(1000).max(100000).optional()})},async args=>textResult("dom_diff",args));
  server.registerTool("wait_for",{description:"Wait for a selector, page text, or page completion.",inputSchema:z.object({tabId:optTabId,selector:z.string().optional(),text:z.string().optional(),timeoutMs:z.number().int().min(100).max(60000).optional(),intervalMs:z.number().int().min(50).max(2000).optional()})},async args=>textResult("wait_for",args,65000));
  server.registerTool("mouse_action",{description:"Advanced mouse action at viewport coordinates.",inputSchema:z.object({tabId:optTabId,kind:z.enum(["double","right","mousedown","mouseup","mousemove","mouseover"]),x:z.number(),y:z.number(),button:z.enum(["left","middle","right"]).optional()})},async args=>textResult("mouse_action",args));
  server.registerTool("draw_path",{description:"Draw any freeform shape or path on the visible page while the virtual cursor traces it smoothly.",inputSchema:z.object({tabId:optTabId,points:z.array(z.object({x:z.number(),y:z.number()})).min(2).max(2400),options:z.object({closed:z.boolean().optional(),clear:z.boolean().optional(),stroke:z.string().optional(),fill:z.string().optional(),width:z.number().min(1).max(24).optional(),durationMs:z.number().min(120).max(12000).optional()}).optional()})},async args=>textResult("draw_path",args,20000));
  server.registerTool("clear_drawings",{description:"Clear shapes drawn by draw_path from the visible page.",inputSchema:z.object({tabId:optTabId})},async args=>textResult("clear_drawings",args));
  server.registerTool("drag_drop",{description:"Drag from one viewport coordinate to another.",inputSchema:z.object({tabId:optTabId,fromX:z.number(),fromY:z.number(),toX:z.number(),toY:z.number()})},async args=>textResult("drag_drop",args));
  server.registerTool("key_combo",{description:"Send a keyboard shortcut to a tab.",inputSchema:z.object({tabId:optTabId,keys:z.array(z.string()).min(1).max(8),selector:z.string().optional()})},async args=>textResult("key_combo",args));
  server.registerTool("zoom",{description:"Set tab zoom; 0 resets and 1 means 100 percent.",inputSchema:z.object({tabId:optTabId,factor:z.number().min(0).max(5)})},async args=>textResult("zoom",args));
  server.registerTool("parallel_actions",{description:"Execute independent commands concurrently, typically across tabs.",inputSchema:z.object({actions:z.array(z.object({command:z.string(),args:z.record(z.string(),z.any()).optional()})).min(1).max(30)})},async args=>textResult("parallel_actions",args,60000));
  server.registerTool("cdp_attach",{description:"Attach Chrome DevTools Protocol to a target tab.",inputSchema:z.object({tabId:optTabId})},async args=>textResult("cdp_attach",args));
  server.registerTool("cdp_detach",{description:"Detach Chrome DevTools Protocol from a target tab.",inputSchema:z.object({tabId:optTabId})},async args=>textResult("cdp_detach",args));
  server.registerTool("cdp_status",{description:"Check CDP attachment status.",inputSchema:z.object({tabId:optTabId})},async args=>textResult("cdp_status",args));
  server.registerTool("network_logs",{description:"Read recent browser network requests captured through Chrome DevTools Protocol.",inputSchema:z.object({tabId:optTabId,limit:z.number().int().min(1).max(200).optional(),clear:z.boolean().optional()})},async args=>textResult("network_logs",args));
  server.registerTool("cdp_command",{description:"Send an allowed Chrome DevTools Protocol command to the target Comet tab.",inputSchema:z.object({tabId:optTabId,method:z.string(),params:z.record(z.string(),z.any()).optional()})},async args=>textResult("cdp_command",args));

  const desktopAlias = command => ({
    desktop_mouse_move:"desktop_move_mouse",
    desktop_mouse_click:"desktop_click",
    desktop_keyboard_type:"desktop_type_text",
    desktop_keyboard_combo:"desktop_key_combo",
    desktop_files_list:"desktop_list_files",
    desktop_file_check:"desktop_file_exists"
  }[command] || command);
  const desktopText = async (command,args={},timeout=30000) => ({ content:[{type:"text",text:JSON.stringify(await callDesktop(desktopAlias(command),args,timeout),null,2)}] });
  server.registerTool("desktop_info",{description:"Report Windows desktop-agent connection and machine info.",inputSchema:z.object({})},async()=>desktopText("desktop_info"));
  server.registerTool("desktop_screen_size",{description:"Get the Windows virtual desktop dimensions.",inputSchema:z.object({})},async()=>desktopText("desktop_screen_size"));
  server.registerTool("desktop_monitors",{description:"List Windows monitors with index, primary flag and coordinates.",inputSchema:z.object({})},async()=>desktopText("desktop_monitors"));
  server.registerTool("desktop_clipboard_get",{description:"Read text from the Windows clipboard when clipboard permission is enabled.",inputSchema:z.object({})},async()=>desktopText("desktop_clipboard_get"));
  server.registerTool("desktop_clipboard_set",{description:"Set Windows clipboard text when clipboard permission is enabled.",inputSchema:z.object({text:z.string().max(20000)})},async args=>desktopText("desktop_clipboard_set",args));
  server.registerTool("desktop_windows",{description:"List visible top-level Windows application windows.",inputSchema:z.object({})},async()=>desktopText("desktop_windows"));
  server.registerTool("desktop_processes",{description:"List Windows processes.",inputSchema:z.object({})},async()=>desktopText("desktop_processes"));
  server.registerTool("desktop_system_info",{description:"Read basic Windows system and drive information.",inputSchema:z.object({})},async()=>desktopText("desktop_system_info"));
  server.registerTool("desktop_screenshot",{description:"Capture the full Windows desktop.",inputSchema:z.object({})},async()=>{
    const shot=await callDesktop("desktop_screenshot",{},30000);
    return {content:[{type:"image",data:shot.data,mimeType:shot.mimeType||"image/png"},{type:"text",text:JSON.stringify({x:shot.x,y:shot.y,width:shot.width,height:shot.height})}]};
  });
  server.registerTool("desktop_mouse_action",{
    description:"One real Windows mouse operation: verified move then click/right/double/scroll, or drag. Coordinates are physical screen pixels including negative monitor origins. Uses one desktop round-trip. Optionally returns one screenshot AFTER the completed action. Do not capture between movement and click.",
    inputSchema:z.object({kind:z.enum(["move","click","right","double","drag","scroll"]),x:z.number().int(),y:z.number().int(),toX:z.number().int().optional(),toY:z.number().int().optional(),durationMs:z.number().int().min(0).max(10000).optional(),button:z.enum(["left","middle","right"]).optional(),delta:z.number().int().min(-12000).max(12000).optional(),horizontal:z.boolean().optional(),screenshotAfter:z.boolean().optional(),settleMs:z.number().int().min(0).max(2000).optional()})
  },async args=>{
    const result=await callDesktop("desktop_mouse_action",args,30000);
    const content=[{type:"text",text:JSON.stringify(result)}];
    if(args.screenshotAfter){
      await new Promise(resolve=>setTimeout(resolve,args.settleMs??120));
      const shot=await callDesktop("desktop_screenshot",{},30000);
      const data=await sharp(Buffer.from(shot.data,"base64")).resize({width:2048,withoutEnlargement:true}).webp({quality:65}).toBuffer();
      content.push({type:"text",text:JSON.stringify({x:shot.x,y:shot.y,sourceWidth:shot.width,sourceHeight:shot.height,coordinateSpace:"physical-screen"})});
      content.push({type:"image",data:data.toString("base64"),mimeType:"image/webp"});
    }
    return {content};
  });
  server.registerTool("control_mouse",{
    description:"Unified Windows/browser mouse. Desktop backend moves the real visible Windows pointer in physical screen pixels including negative origins, including inside browser windows and Explorer. Browser backend uses CSS viewport coordinates through CDP; it does not move the Windows cursor. Move then click is one operation.",
    inputSchema:z.object({backend:z.enum(["desktop","browser"]).default("desktop"),kind:z.enum(["move","click","right","double","drag","scroll"]),tabId:z.number().int().optional(),x:z.number(),y:z.number(),toX:z.number().optional(),toY:z.number().optional(),button:z.enum(["left","middle","right"]).optional(),durationMs:z.number().int().min(0).max(10000).optional(),delta:z.number().int().min(-12000).max(12000).optional(),horizontal:z.boolean().optional()})
  },async args=>{
    if(args.backend==="desktop")return desktopText("desktop_mouse_action",args);
    if(args.kind==="drag")return textResult("drag_drop",{...args,fromX:args.x,fromY:args.y},30000);
    if(args.kind==="scroll")return textResult("scroll",{tabId:args.tabId,x:args.horizontal?(args.delta??120):0,y:args.horizontal?0:(args.delta??120)});
    return textResult("mouse_action",{...args,kind:args.kind==="move"?"mousemove":args.kind});
  });
  server.registerTool("desktop_cursor_position",{description:"Read current Windows cursor coordinates.",inputSchema:z.object({})},async args=>desktopText("desktop_cursor_position",args));
  server.registerTool("desktop_move_mouse",{description:"Smoothly move the real Windows mouse pointer.",inputSchema:z.object({x:z.number(),y:z.number(),durationMs:z.number().int().min(0).max(10000).optional()})},async args=>desktopText("desktop_move_mouse",args));
  server.registerTool("desktop_mouse_move",{description:"Alias for desktop_move_mouse. Smoothly move the real Windows mouse pointer.",inputSchema:z.object({x:z.number(),y:z.number(),durationMs:z.number().int().min(0).max(10000).optional()})},async args=>desktopText("desktop_mouse_move",args));
  server.registerTool("desktop_click",{description:"Move and click the real Windows mouse.",inputSchema:z.object({x:z.number().optional(),y:z.number().optional(),durationMs:z.number().int().min(0).max(10000).optional(),button:z.enum(["left","right"]).optional(),count:z.number().int().min(1).max(3).optional()})},async args=>desktopText("desktop_click",args));
  server.registerTool("desktop_mouse_path",{description:"Move the real Windows pointer smoothly through a path; optionally hold the mouse button for drawing or dragging.",inputSchema:z.object({points:z.array(z.object({x:z.number(),y:z.number()})).min(2).max(1000),durationMs:z.number().int().min(20).max(15000).optional(),press:z.boolean().optional(),button:z.enum(["left","right"]).optional()})},async args=>desktopText("desktop_mouse_path",args,30000));
  server.registerTool("desktop_type_text",{description:"Type text with the real Windows keyboard into the focused control.",inputSchema:z.object({text:z.string().max(20000),intervalMs:z.number().int().min(0).max(1000).optional()})},async args=>desktopText("desktop_type_text",args));
  server.registerTool("desktop_key_combo",{description:"Send a Windows keyboard shortcut.",inputSchema:z.object({keys:z.array(z.string()).min(1).max(8)})},async args=>desktopText("desktop_key_combo",args));
  server.registerTool("desktop_file_exists",{description:"Check whether a local Windows file or directory exists.",inputSchema:z.object({path:z.string()})},async args=>desktopText("desktop_file_exists",args));
  server.registerTool("desktop_list_files",{description:"List files and folders in a Windows directory.",inputSchema:z.object({path:z.string().optional()})},async args=>desktopText("desktop_list_files",args));
  server.registerTool("desktop_create_folder",{description:"Create a folder on Windows when file-write permission is enabled.",inputSchema:z.object({path:z.string()})},async args=>desktopText("desktop_create_folder",args));
  server.registerTool("desktop_copy_file",{description:"Copy a Windows file when file-write permission is enabled.",inputSchema:z.object({source:z.string(),destination:z.string(),overwrite:z.boolean().optional()})},async args=>desktopText("desktop_copy_file",args));
  server.registerTool("desktop_move_file",{description:"Move or rename a Windows file when file-write permission is enabled.",inputSchema:z.object({source:z.string(),destination:z.string(),overwrite:z.boolean().optional()})},async args=>desktopText("desktop_move_file",args));
  server.registerTool("desktop_extract_zip",{description:"Extract a ZIP archive on Windows directly to a destination folder.",inputSchema:z.object({source:z.string(),destination:z.string(),overwrite:z.boolean().optional()})},async args=>desktopText("desktop_extract_zip",args,60000));
  server.registerTool("desktop_copy_directory",{description:"Recursively copy a Windows directory.",inputSchema:z.object({source:z.string(),destination:z.string(),overwrite:z.boolean().optional()})},async args=>desktopText("desktop_copy_directory",args,60000));
  server.registerTool("desktop_open_path",{description:"Open a Windows file, folder, or ZIP path with its default application.",inputSchema:z.object({path:z.string()})},async args=>desktopText("desktop_open_path",args));
  server.registerTool("desktop_scroll",{description:"Scroll with the real Windows mouse wheel, vertically or horizontally.",inputSchema:z.object({delta:z.number().int().min(-12000).max(12000).optional(),horizontal:z.boolean().optional()})},async args=>desktopText("desktop_scroll",args));
  server.registerTool("desktop_window_activate",{description:"Bring a top-level Windows application window to the foreground by PID.",inputSchema:z.object({pid:z.number().int()})},async args=>desktopText("desktop_window_activate",args));
  server.registerTool("desktop_window_minimize",{description:"Minimize a top-level Windows application window by PID.",inputSchema:z.object({pid:z.number().int()})},async args=>desktopText("desktop_window_minimize",args));
  server.registerTool("desktop_window_maximize",{description:"Maximize a top-level Windows application window by PID.",inputSchema:z.object({pid:z.number().int()})},async args=>desktopText("desktop_window_maximize",args));
  server.registerTool("desktop_window_restore",{description:"Restore a top-level Windows application window by PID.",inputSchema:z.object({pid:z.number().int()})},async args=>desktopText("desktop_window_restore",args));
  server.registerTool("desktop_window_move",{description:"Move/resize a top-level Windows application window by PID.",inputSchema:z.object({pid:z.number().int(),x:z.number().int(),y:z.number().int(),width:z.number().int(),height:z.number().int()})},async args=>desktopText("desktop_window_move",args));

  return server;
}

const mcpHandler = createMcpHandler(() => makeMcpServer());
const nodeMcpHandler = toNodeHandler(mcpHandler);

const httpServer = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url || "/", "http://localhost"); }
  catch { res.writeHead(400); res.end("Bad Request"); return; }

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      service: "comet-chatgpt-bridge",
      version: "0.7.17",
      mcp: "ready",
      browserConnected: !!browserSocket && browserSocket.readyState === WebSocket.OPEN,
      browserConnectedAt,
      desktopConnected: !!desktopSocket && desktopSocket.readyState === WebSocket.OPEN,
      desktopConnectedAt,
      uptimeSeconds: Math.round(process.uptime())
    }));
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "comet-chatgpt-bridge", version: "0.7.17", status: "ok", mcp: "/mcp" }));
    return;
  }

  if (url.pathname === "/mcp") {
    void nodeMcpHandler(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url || "/", "http://localhost"); } catch { socket.destroy(); return; }
  if (!["/browser","/desktop"].includes(url.pathname) || !BRIDGE_TOKEN || url.searchParams.get("token") !== BRIDGE_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (socket, req) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  const isDesktop = path === "/desktop";
  if (isDesktop) {
    if (desktopSocket && desktopSocket.readyState === WebSocket.OPEN) desktopSocket.close(4001, "Replaced by newer desktop connection");
    desktopSocket = socket;
    desktopConnectedAt = new Date().toISOString();
  } else {
    if (browserSocket && browserSocket.readyState === WebSocket.OPEN) browserSocket.close(4000, "Replaced by newer Comet connection");
    browserSocket = socket;
    browserConnectedAt = new Date().toISOString();
  }

  socket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }
    if (msg.type === "result" && msg.id) {
      const map = isDesktop ? desktopPending : pending;
      if (map.has(msg.id)) {
        const item = map.get(msg.id);
        clearTimeout(item.timer);
        map.delete(msg.id);
        msg.ok ? item.resolve(msg.result) : item.reject(new Error(msg.error || (isDesktop ? "Desktop command failed" : "Browser command failed")));
      }
    }
  });
  socket.on("close", () => {
    const map=isDesktop?desktopPending:pending;
    for(const [id,item] of map){
      if(item.socket!==socket)continue;
      clearTimeout(item.timer);map.delete(id);
      item.reject(new Error("Bridge disconnected during command; execution outcome unknown. Observe state before retrying."));
    }
    if (isDesktop && desktopSocket === socket) { desktopSocket = null; desktopConnectedAt = null; }
    if (!isDesktop && browserSocket === socket) { browserSocket = null; browserConnectedAt = null; }
  });
  socket.on("error",()=>socket.close());
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Comet ChatGPT Bridge v0.7.17 listening on 0.0.0.0:${PORT}`);
  console.log("MCP v2 handler ready at /mcp | WSS /browser + /desktop | health /health");
});

process.on("SIGTERM", async () => {
  try { await mcpHandler.close(); } catch {}
  httpServer.close(() => process.exit(0));
});
