const WS_URL = "ws://127.0.0.1:8788";
let ws = null;
let reconnectTimer = null;
let pingTimer = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type !== "command" || !msg.id) return;

    try {
      const result = await executeCommand(msg.command, msg.args || {});
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(error?.message || error) }));
    }
  };

  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

async function runInTab(tabId, func, args = []) {
  const [out] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return out?.result;
}

function pageSnapshot(maxChars) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const nodes = [...document.querySelectorAll("button,a,input,textarea,select,[role='button'],[contenteditable='true']")]
    .slice(0, 400)
    .map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      text: clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").slice(0, 240),
      id: el.id || null,
      name: el.getAttribute("name"),
      role: el.getAttribute("role"),
      type: el.getAttribute("type"),
      placeholder: el.getAttribute("placeholder")
    }));

  return {
    title: document.title,
    url: location.href,
    text: clean(document.body?.innerText || "").slice(0, maxChars),
    interactive: nodes
  };
}

function clickTarget(selector, text) {
  let el = null;
  if (selector) el = document.querySelector(selector);
  if (!el && text) {
    const target = text.toLowerCase().trim();
    const candidates = [...document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']")];
    el = candidates.find(x => ((x.innerText || x.value || x.getAttribute("aria-label") || "").trim().toLowerCase() === target)) ||
         candidates.find(x => ((x.innerText || x.value || x.getAttribute("aria-label") || "").trim().toLowerCase().includes(target)));
  }
  if (!el) throw new Error("Clickable element not found");
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { clicked: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 200) };
}

function typeTarget(selector, text, clearFirst) {
  const el = document.querySelector(selector);
  if (!el) throw new Error("Input element not found");
  el.focus();
  if ("value" in el) {
    if (clearFirst) el.value = "";
    el.value = clearFirst ? text : (el.value || "") + text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    if (clearFirst) el.textContent = "";
    el.textContent = clearFirst ? text : (el.textContent || "") + text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  } else {
    throw new Error("Target is not editable");
  }
  return { typed: true };
}

async function executeCommand(command, args) {
  switch (command) {
    case "get_page": {
      const tab = await activeTab();
      const result = await runInTab(tab.id, pageSnapshot, [Math.min(Math.max(Number(args.maxChars || 30000), 1000), 100000)]);
      return { tabId: tab.id, ...result };
    }
    case "click": {
      const tab = await activeTab();
      return await runInTab(tab.id, clickTarget, [args.selector || null, args.text || null]);
    }
    case "type": {
      const tab = await activeTab();
      return await runInTab(tab.id, typeTarget, [args.selector, String(args.text ?? ""), args.clearFirst !== false]);
    }
    case "navigate": {
      const tab = await activeTab();
      await chrome.tabs.update(tab.id, { url: args.url });
      return { navigated: true, tabId: tab.id, url: args.url };
    }
    case "screenshot": {
      const tab = await activeTab();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { tabId: tab.id, dataUrl };
    }
    case "list_tabs": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs.map(t => ({ id: t.id, active: t.active, title: t.title, url: t.url }));
    }
    case "activate_tab": {
      const tabId = Number(args.tabId);
      if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
      await chrome.tabs.update(tabId, { active: true });
      return { activated: true, tabId };
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.action.onClicked.addListener(connect);
connect();
