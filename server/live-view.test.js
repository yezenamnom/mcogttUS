import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import sharp from "sharp";

test("private live-view resource, auth, monitor selection and frame delivery", async () => {
  const port = 39188;
  const base = `http://127.0.0.1:${port}`;
  const token = "live-view-test-only";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: String(port), BRIDGE_TOKEN: token }, stdio: "pipe"
  });
  let logs = "";
  child.stderr.on("data", data => { logs += data; });
  child.stdout.on("data", data => { logs += data; });
  let socket;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    const png = await sharp({ create: { width: 1600, height: 900, channels: 4, background: "#385b9a" } }).png().toBuffer();
    const jpeg = await sharp(png).resize({ width: 1280 }).jpeg({ quality: 58 }).toBuffer();
    socket = new WebSocket(`ws://127.0.0.1:${port}/desktop?token=${token}`);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const commands = [];
    socket.on("message", raw => {
      const command = JSON.parse(raw.toString());
      commands.push(command);
      const result = command.command === "desktop_monitors"
        ? [{ index: 0, name: "Primary", width: 1600, height: 900, primary: true }, { index: 1, name: "Second", width: 1600, height: 900, primary: false }]
        : command.command === "desktop_stream_frame"
          ? { mimeType: "image/jpeg", data: jpeg.toString("base64"), screen: command.args.screen, width: 1280, height: 720 }
          : { mimeType: "image/png", data: png.toString("base64"), screen: command.args.screen };
      socket.send(JSON.stringify({ type: "result", id: command.id, ok: true, result }));
    });
    const unauthorized = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    let session;
    async function rpc(id, method, params) {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
      if (session) headers["mcp-session-id"] = session;
      const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      assert.ok(response.ok, await response.clone().text());
      session = response.headers.get("mcp-session-id") || session;
      const body = await response.text();
      const json = body.startsWith("{") ? body : body.split("\n").find(line => line.startsWith("data:"))?.slice(5);
      return JSON.parse(json);
    }
    const initialized = await rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "live-view-test", version: "1" } });
    assert.match(initialized.result.instructions, /نفّذ أولًا، ثم تحقق/);
    const tools = (await rpc(2, "tools/list", {})).result.tools;
    assert.equal(tools.find(t => t.name === "open_live_view")._meta.ui.resourceUri, "ui://gpt-us/live-view-v26.html");
    assert.equal(tools.find(t => t.name === "open_live_view")._meta["openai/outputTemplate"], "ui://gpt-us/live-view-v26.html");
    assert.equal(tools.find(t => t.name === "open_live_view")._meta["openai/widgetAccessible"], true);
    assert.deepEqual(tools.find(t => t.name === "live_view_frame")._meta.ui.visibility, ["app"]);
    assert.deepEqual(tools.find(t => t.name === "live_view_state")._meta.ui.visibility, ["app"]);
    assert.equal(tools.find(t => t.name === "open_smart_panel")._meta.ui.resourceUri, "ui://gpt-us/smart-actions.html");
    assert.deepEqual(tools.find(t => t.name === "smart_action_state")._meta.ui.visibility, ["app"]);
    const smartResource = await rpc(30, "resources/read", { uri: "ui://gpt-us/smart-actions.html" });
    assert.match(smartResource.result.contents[0].text, /الخطوة التالية/);
    const smartOpened = await rpc(31, "tools/call", { name: "open_smart_panel", arguments: { task: "غيّر الصوت" } });
    assert.equal(smartOpened.result.structuredContent.phase, "idle");
    const resource = await rpc(3, "resources/read", { uri: "ui://gpt-us/live-view-v26.html" });
    assert.match(resource.result.contents[0].text, /الكمبيوتر المباشر/);
    assert.match(resource.result.contents[0].text, /const embeddedState = null/);
    assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.equal(resource.result.contents[0]._meta["openai/ui"].preferredDisplayMode, "fullscreen");
    assert.deepEqual(resource.result.contents[0]._meta["openai/ui"].availableDisplayModes, ["inline", "fullscreen"]);
    assert.deepEqual(resource.result.contents[0]._meta.ui.csp, { connectDomains: ["https://mcogttus-production.up.railway.app", "wss://mcogttus-production.up.railway.app"], resourceDomains: [] });
    const opened = await rpc(4, "tools/call", { name: "open_live_view", arguments: {} });
    const bootstrap = opened.result.structuredContent;
    assert.match(bootstrap.streamUrl, /^wss:\/\/mcogttus-production\.up\.railway\.app\/live\?ticket=/);
    assert.match(bootstrap.viewerUrl, /^https:\/\/mcogttus-production\.up\.railway\.app\/viewer\?ticket=/);
    const viewerTicket = new URL(bootstrap.viewerUrl).searchParams.get("ticket");
    let viewerResponse;
    try { viewerResponse = await fetch(`http://127.0.0.1:${port}/viewer?ticket=${viewerTicket}`); }
    catch (error) { throw new Error(`${error.message}\n${logs}`); }
    assert.equal(viewerResponse.status, 200);
    assert.match(viewerResponse.headers.get("cache-control"), /no-store/);
    assert.match(await viewerResponse.text(), /الكمبيوتر المباشر/);
    const ticket = new URL(bootstrap.streamUrl).searchParams.get("ticket");
    const live = new WebSocket(`ws://127.0.0.1:${port}/live?ticket=${ticket}`);
    await new Promise((resolve, reject) => { live.once("open", resolve); live.once("error", reject); });
    const messages = [];
    live.on("message", (data, binary) => messages.push({ data, binary }));
    live.send(JSON.stringify({ type: "select", screen: 1 }));
    for (let i = 0; i < 80 && !messages.some(item => item.binary); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(messages.some(item => item.binary && item.data.length > 100), "private websocket delivers a binary compressed frame");
    const capture = new WebSocket(`ws://127.0.0.1:${port}/capture?token=${token}`);
    await new Promise((resolve, reject) => { capture.once("open", resolve); capture.once("error", reject); });
    live.send(JSON.stringify({ type: "select", source: "browser" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    capture.send(JSON.stringify({ type:"capture_state", active:true, mimeType:"video/webm;codecs=vp8,opus", audio:true }));
    const webm = Buffer.from("test-webm-chunk");
    capture.send(JSON.stringify({ type:"capture_chunk", mimeType:"video/webm;codecs=vp8,opus", sequence:0, at:Date.now(), width:1920, height:1080, fps:60, audio:true }));
    capture.send(webm, { binary:true });
    for (let i = 0; i < 40 && !messages.some(item => item.binary && item.data.equals(webm)); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(messages.some(item => !item.binary && JSON.parse(item.data.toString()).type === "webm"), "browser stream metadata reaches viewer");
    assert.ok(messages.some(item => item.binary && item.data.equals(webm)), "browser WebM chunk reaches viewer");
    capture.close();
    live.close();
    assert.equal(opened.result.structuredContent.monitors.length, 2);
    const recovered = await rpc(40, "tools/call", { name: "live_view_state", arguments: {} });
    assert.equal(recovered.result.structuredContent.monitors.length, 2);
    const frame = await rpc(5, "tools/call", { name: "live_view_frame", arguments: { screen: 1 } });
    assert.equal(frame.result.isError, undefined);
    assert.equal(frame.result._meta.frame.screen, 1);
    assert.match(frame.result._meta.frame.dataUrl, /^data:image\/jpeg;base64,/);
    assert.match(frame.result.structuredContent.frame.dataUrl, /^data:image\/jpeg;base64,/);
    assert.ok(frame.result._meta.frame.width <= 1280);
    assert.ok(!JSON.stringify(frame.result.content).includes("base64"), "frame bytes stay out of model-visible text");
    assert.equal(commands.at(-1).command, "desktop_stream_frame");
    assert.equal(commands.at(-1).args.screen, 1);
    const observed = await rpc(50, "tools/call", { name: "desktop_observe", arguments: { screen: 1 } });
    assert.equal(observed.result.structuredContent.changed, true);
    const unchanged = await rpc(51, "tools/call", { name: "desktop_observe", arguments: { screen: 1 } });
    assert.equal(unchanged.result.structuredContent.changed, false);
    assert.ok(unchanged.result.content.some(item => item.type === "image"), "A new question receives a fresh image even when the desktop is unchanged");
    const conditional = await rpc(52, "tools/call", { name: "desktop_observe", arguments: { screen: 1, onlyIfChanged: true } });
    assert.ok(!conditional.result.content.some(item => item.type === "image"), "Explicit change-only observation remains available");
    const invalid = await rpc(6, "tools/call", { name: "live_view_frame", arguments: { screen: 7 } });
    assert.equal(invalid.result.isError, true);
    assert.ok(!commands.some(c => c.command === "desktop_stream_frame" && c.args.screen === 7));
  } finally {
    socket?.close(); child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  }
});


