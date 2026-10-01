import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
if (!BRIDGE_TOKEN) console.warn("WARNING: BRIDGE_TOKEN is not set.");

const app = express();
app.use(express.json({ limit: "2mb" }));
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let browserSocket = null;
let browserConnectedAt = null;
const pending = new Map();

function authorized(req) {
  if (!BRIDGE_TOKEN) return false;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${BRIDGE_TOKEN}`;
}

httpServer.on("upgrade", (req, socket, head) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { socket.destroy(); return; }
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

function createMcpServer() {
  const server = new McpServer({ name: "comet-browser", version: "0.2.0" });

  server.tool("get_page", "Read the active Comet tab: title, URL, visible text, and interactive elements.",
    { maxChars: z.number().int().min(1000).max(100000).optional() },
    async ({ maxChars }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("get_page", { maxChars }), null, 2) }] }));

  server.tool("click", "Click an element in the active tab by CSS selector or visible text.",
    { selector: z.string().optional(), text: z.string().optional() },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("click", args), null, 2) }] }));

  server.tool("type", "Type text into an editable element selected by CSS selector.",
    { selector: z.string(), text: z.string(), clearFirst: z.boolean().optional() },
    async args => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("type", args), null, 2) }] }));

  server.tool("navigate", "Navigate the active Comet tab to a URL.",
    { url: z.string().url() },
    async ({ url }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("navigate", { url }), null, 2) }] }));

  server.tool("screenshot", "Capture a PNG screenshot of the visible area of the active Comet tab.",
    {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("screenshot"), null, 2) }] }));

  server.tool("list_tabs", "List tabs in the current Comet window.",
    {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("list_tabs"), null, 2) }] }));

  server.tool("activate_tab", "Activate a Comet tab by tab ID.",
    { tabId: z.number().int() },
    async ({ tabId }) => ({ content: [{ type: "text", text: JSON.stringify(await callBrowser("activate_tab", { tabId }), null, 2) }] }));

  return server;
}

app.get("/", (_req, res) => res.json({ service: "comet-chatgpt-bridge", version: "0.2.0", status: "ok" }));
app.get("/health", (_req, res) => res.status(200).json({
  ok: true,
  service: "comet-chatgpt-bridge",
  version: "0.2.0",
  browserConnected: !!browserSocket && browserSocket.readyState === WebSocket.OPEN,
  browserConnectedAt,
  uptimeSeconds: Math.round(process.uptime())
}));

app.all("/mcp", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    try { transport.close(); } catch {}
    try { mcp.close(); } catch {}
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Comet ChatGPT Bridge v0.2 listening on 0.0.0.0:${PORT}`);
  console.log("HTTP health: /health | WebSocket: /browser | MCP: /mcp");
});
