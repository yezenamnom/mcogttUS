let ws = null;
let reconnectTimer = null;
let pingTimer = null;

async function getConfig() {
  const cfg = await chrome.storage.local.get(["bridgeUrl", "bridgeToken"]);
  return {
    bridgeUrl: (cfg.bridgeUrl || "").trim().replace(/\/$/, ""),
    bridgeToken: (cfg.bridgeToken || "").trim()
  };
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { bridgeUrl, bridgeToken } = await getConfig();
  if (!bridgeUrl || !bridgeToken) {
    chrome.action.setBadgeText({ text: "SET" });
    chrome.action.setBadgeBackgroundColor({ color: "#f57c00" });
    return;
  }
  const wsBase = bridgeUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  ws = new WebSocket(`${wsBase}/browser?token=${encodeURIComponent(bridgeToken)}`);

  ws.onopen = () => {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  };

  ws.onmessage = async event => {
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
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
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
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const nodes = [...document.querySelectorAll("button,a,input,textarea,select,[role='button'],[contenteditable='true']")].slice(0, 400).map((el,index)=>({
    index, tag: el.tagName.toLowerCase(),
    text: clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").slice(0,240),
    id: el.id || null, name: el.getAttribute("name"), role: el.getAttribute("role"),
    type: el.getAttribute("type"), placeholder: el.getAttribute("placeholder")
  }));
  return { title: document.title, url: location.href, text: clean(document.body?.innerText || "").slice(0,maxChars), interactive:nodes };
}
function clickTarget(selector,text) {
  let el = selector ? document.querySelector(selector) : null;
  if (!el && text) {
    const target=text.toLowerCase().trim();
    const candidates=[...document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']")];
    el=candidates.find(x=>((x.innerText||x.value||x.getAttribute("aria-label")||"").trim().toLowerCase()===target)) ||
       candidates.find(x=>((x.innerText||x.value||x.getAttribute("aria-label")||"").trim().toLowerCase().includes(target)));
  }
  if(!el) throw new Error("Clickable element not found");
  el.scrollIntoView({block:"center",inline:"center"}); el.click();
  return {clicked:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||"").trim().slice(0,200)};
}
function typeTarget(selector,text,clearFirst) {
  const el=document.querySelector(selector); if(!el) throw new Error("Input element not found"); el.focus();
  if("value" in el){ if(clearFirst) el.value=""; el.value=clearFirst?text:(el.value||"")+text; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
  else if(el.isContentEditable){ if(clearFirst) el.textContent=""; el.textContent=clearFirst?text:(el.textContent||"")+text; el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text})); }
  else throw new Error("Target is not editable");
  return {typed:true};
}

function scrollPage(x,y,behavior) { window.scrollBy({left:x,top:y,behavior:behavior||"smooth"}); return {scrolled:true,x:window.scrollX,y:window.scrollY}; }
function hoverTarget(selector,text) { let el=selector?document.querySelector(selector):null; if(!el&&text){const q=text.toLowerCase();el=[...document.querySelectorAll("a,button,input,select,textarea,[role='button'],*")].find(e=>(e.innerText||e.value||"").trim().toLowerCase().includes(q));} if(!el) throw new Error("Element not found"); el.scrollIntoView({block:"center"}); el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true})); el.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true})); return {hovered:true}; }
function selectTarget(selector,value) { const el=document.querySelector(selector); if(!el||el.tagName!=="SELECT") throw new Error("Select element not found"); el.value=value; el.dispatchEvent(new Event("change",{bubbles:true})); return {selected:true,value:el.value}; }

async function executeCommand(command,args){
  switch(command){
    case "get_page": { const tab=await activeTab(); const result=await runInTab(tab.id,pageSnapshot,[Math.min(Math.max(Number(args.maxChars||30000),1000),100000)]); return {tabId:tab.id,...result}; }
    case "click": { const tab=await activeTab(); return await runInTab(tab.id,clickTarget,[args.selector||null,args.text||null]); }
    case "type": { const tab=await activeTab(); return await runInTab(tab.id,typeTarget,[args.selector,String(args.text??""),args.clearFirst!==false]); }
    case "navigate": { const tab=await activeTab(); await chrome.tabs.update(tab.id,{url:args.url}); return {navigated:true,tabId:tab.id,url:args.url}; }
    case "screenshot": { const tab=await activeTab(); const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"}); return {tabId:tab.id,dataUrl}; }
    case "list_tabs": { const tabs=await chrome.tabs.query({currentWindow:true}); return tabs.map(t=>({id:t.id,active:t.active,title:t.title,url:t.url})); }
    case "activate_tab": { const tabId=Number(args.tabId); if(!Number.isInteger(tabId)) throw new Error("tabId must be an integer"); await chrome.tabs.update(tabId,{active:true}); return {activated:true,tabId}; }
    case "new_tab": { const tab=await chrome.tabs.create({url:args.url||"about:blank",active:args.active!==false}); return {created:true,tabId:tab.id,url:tab.url}; }
    case "close_tab": { const tabId=args.tabId?Number(args.tabId):(await activeTab()).id; await chrome.tabs.remove(tabId); return {closed:true,tabId}; }
    case "duplicate_tab": { const tabId=args.tabId?Number(args.tabId):(await activeTab()).id; const tab=await chrome.tabs.duplicate(tabId); return {duplicated:true,tabId:tab.id}; }
    case "reload": { const tab=await activeTab(); await chrome.tabs.reload(tab.id,{bypassCache:!!args.bypassCache}); return {reloaded:true,tabId:tab.id}; }
    case "go_back": { const tab=await activeTab(); await chrome.tabs.goBack(tab.id); return {back:true,tabId:tab.id}; }
    case "go_forward": { const tab=await activeTab(); await chrome.tabs.goForward(tab.id); return {forward:true,tabId:tab.id}; }
    case "scroll": { const tab=await activeTab(); return await runInTab(tab.id,scrollPage,[Number(args.x||0),Number(args.y||0),args.behavior||"smooth"]); }
    case "hover": { const tab=await activeTab(); return await runInTab(tab.id,hoverTarget,[args.selector||null,args.text||null]); }
    case "select": { const tab=await activeTab(); return await runInTab(tab.id,selectTarget,[args.selector,String(args.value)]); }
    default: throw new Error(`Unknown command: ${command}`);
  }
}
chrome.runtime.onInstalled.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, areaName)=>{
  if (areaName !== "local" || (!changes.bridgeUrl && !changes.bridgeToken)) return;
  clearTimeout(reconnectTimer);
  try { ws?.close(); } catch {}
  ws = null;
  setTimeout(connect, 300);
});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
connect();
