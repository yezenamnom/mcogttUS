import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";

const wss = new WebSocketServer({ host: "127.0.0.1", port: 8788 });
let browserSocket = null;
const pending = new Map();

wss.on("connection", (socket) => {
  browserSocket = socket;
  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "ping") return;
    if (msg.type === "result" && msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error || "Browser command failed"));
    }
  });
  socket.on("close", () => {
    if (browserSocket === socket) browserSocket = null;
  });
});

function callBrowser(command, args = {}, timeoutMs = 20000) {
  if (!browserSocket || browserSocket.readyState !== browserSocket.OPEN) {
    throw new Error("Comet extension is not connected. Start Comet and load the extension.");
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

const server = new McpServer({ name: "comet-browser", version: "0.1.0" });

server.tool(
  "get_page",
  "Read the active Comet tab: title, URL, visible text, and interactive elements.",
  { maxChars: z.number().int().min(1000).max(100000).optional() },
  async ({ maxChars }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("get_page", { maxChars }), null, 2) }] })
);

server.tool(
  "click",
  "Click an element in the active tab by CSS selector or visible text.",
  { selector: z.string().optional(), text: z.string().optional() },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("click", args), null, 2) }] })
);

server.tool(
  "type",
  "Type text into an editable element selected by CSS selector.",
  { selector: z.string(), text: z.string(), clearFirst: z.boolean().optional() },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("type", args), null, 2) }] })
);

server.tool(
  "navigate",
  "Navigate the active Comet tab to a URL.",
  { url: z.string().url() },
  async ({ url }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("navigate", { url }), null, 2) }] })
);

server.tool(
  "screenshot",
  "Capture a PNG screenshot of the visible area of the active Comet tab. Returns a data URL.",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("screenshot"), null, 2) }] })
);

server.tool(
  "list_tabs",
  "List tabs in the current Comet window.",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("list_tabs"), null, 2) }] })
);

server.tool(
  "activate_tab",
  "Activate a Comet tab by tab ID.",
  { tabId: z.number().int() },
  async ({ tabId }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("activate_tab", { tabId }), null, 2) }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
