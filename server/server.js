import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
if (!BRIDGE_TOKEN) console.warn("WARNING: BRIDGE_TOKEN is not set.");

let browserSocket = null;
let browserConnectedAt = null;
const pending = new Map();
const wss = new WebSocketServer({ noServer: true });

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
    pending.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ type: "command", id, command, args }));
  });
}

function makeMcpServer() {
  const server = new McpServer({ name: "comet-browser", version: "0.5.0" });

  server.registerTool("get_page", {
    description: "Read the active Comet tab: title, URL, visible text, and interactive elements.",
    inputSchema: z.object({ maxChars: z.number().int().min(1000).max(100000).optional() })
  }, async ({ maxChars }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("get_page", { maxChars }), null, 2) }] }));

  server.registerTool("click", {
    description: "Click an element in the active tab by CSS selector or visible text.",
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
    description: "Capture a PNG screenshot of the visible area of the active Comet tab.",
    inputSchema: z.object({})
  }, async () => {
    const shot = await callBrowser("screenshot");
    const match = /^data:(image\/png);base64,(.+)$/.exec(shot?.dataUrl || "");
    if (!match) throw new Error("Browser did not return a valid PNG screenshot");
    return { content: [{ type: "image", data: match[2], mimeType: match[1] }] };
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
    description: "Execute multiple browser commands sequentially in one MCP call for lower latency.",
    inputSchema: z.object({ actions:z.array(z.object({ command:z.string(), args:z.record(z.string(),z.any()).optional() })).min(1).max(50) })
  }, async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("batch_actions", args, 60000), null, 2) }] }));

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
      version: "0.5.0",
      mcp: "ready",
      browserConnected: !!browserSocket && browserSocket.readyState === WebSocket.OPEN,
      browserConnectedAt,
      uptimeSeconds: Math.round(process.uptime())
    }));
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "comet-chatgpt-bridge", version: "0.5.0", status: "ok", mcp: "/mcp" }));
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
  if (url.pathname !== "/browser" || !BRIDGE_TOKEN || url.searchParams.get("token") !== BRIDGE_TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", socket => {
  if (browserSocket && browserSocket.readyState === WebSocket.OPEN) browserSocket.close(4000, "Replaced by newer Comet connection");
  browserSocket = socket;
  browserConnectedAt = new Date().toISOString();

  socket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }
    if (msg.type === "result" && msg.id && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      clearTimeout(item.timer);
      pending.delete(msg.id);
      msg.ok ? item.resolve(msg.result) : item.reject(new Error(msg.error || "Browser command failed"));
    }
  });
  socket.on("close", () => {
    if (browserSocket === socket) {
      browserSocket = null;
      browserConnectedAt = null;
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Comet ChatGPT Bridge v0.5.0 listening on 0.0.0.0:${PORT}`);
  console.log("MCP v2 handler ready at /mcp | WSS /browser | health /health");
});

process.on("SIGTERM", async () => {
  try { await mcpHandler.close(); } catch {}
  httpServer.close(() => process.exit(0));
});
