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


function pointTarget(x,y,clickIt) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error("x/y must be numbers");
  const el=document.elementFromPoint(x,y);
  if(!el) throw new Error("No element at coordinates");
  let marker=document.getElementById("__cgb_cursor");
  if(!marker){ marker=document.createElement("div"); marker.id="__cgb_cursor"; Object.assign(marker.style,{position:"fixed",width:"18px",height:"18px",border:"2px solid #ff3b30",borderRadius:"50%",zIndex:"2147483647",pointerEvents:"none",transform:"translate(-50%,-50%)",boxShadow:"0 0 0 2px rgba(255,255,255,.9)"}); document.documentElement.appendChild(marker); }
  marker.style.left=x+"px"; marker.style.top=y+"px";
  el.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:x,clientY:y,view:window}));
  el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,clientX:x,clientY:y,view:window}));
  if(clickIt){ el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,clientX:x,clientY:y,view:window})); el.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,clientX:x,clientY:y,view:window})); el.click(); }
  const r=el.getBoundingClientRect();
  return {moved:true,clicked:!!clickIt,x,y,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||el.getAttribute("aria-label")||"").trim().slice(0,160),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
}
function inspectForm() {
  const clean=s=>(s||"").replace(/\s+/g," ").trim();
  const fields=[...document.querySelectorAll("input,textarea,select,[contenteditable='true']")].filter(el=>el.type!=="hidden").slice(0,300).map((el,index)=>{
    const id=el.id||""; const label=(id&&document.querySelector('label[for="'+CSS.escape(id)+'"]')) || el.closest("label");
    const r=el.getBoundingClientRect();
    return {index,tag:el.tagName.toLowerCase(),type:el.type||null,id:id||null,name:el.name||null,label:clean(label?.innerText),placeholder:el.placeholder||null,ariaLabel:el.getAttribute("aria-label"),value:el.value??el.textContent??"",required:!!el.required,disabled:!!el.disabled,options:el.tagName==="SELECT"?[...el.options].map(o=>({value:o.value,text:clean(o.text)})).slice(0,100):undefined,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  });
  return {title:document.title,url:location.href,fields};
}
function setNativeValue(el,value) {
  if(el.tagName==="SELECT"){ el.value=String(value); el.dispatchEvent(new Event("change",{bubbles:true})); return; }
  if(el.type==="checkbox"||el.type==="radio"){ el.checked=!!value; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return; }
  if(el.isContentEditable){ el.focus(); el.textContent=String(value); el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:String(value)})); return; }
  const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;
  el.focus(); setter?setter.call(el,String(value)):(el.value=String(value));
  el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));
}
function fillForm(items) {
  const done=[]; const all=[...document.querySelectorAll("input,textarea,select,[contenteditable='true']")];
  for(const item of items||[]){
    let el=item.selector?document.querySelector(item.selector):null;
    if(!el&&item.name) el=all.find(e=>e.name===item.name);
    if(!el&&item.id) el=document.getElementById(item.id);
    if(!el&&Number.isInteger(item.index)) el=all.filter(e=>e.type!=="hidden")[item.index];
    if(!el) throw new Error("Form field not found: "+JSON.stringify(item));
    setNativeValue(el,item.value); done.push({id:el.id||null,name:el.name||null,type:el.type||el.tagName.toLowerCase()});
  }
  return {filled:true,count:done.length,fields:done};
}
function pressKey(key,selector) {
  const el=selector?document.querySelector(selector):document.activeElement;
  if(!el) throw new Error("Key target not found");
  el.focus?.(); for(const type of ["keydown","keypress","keyup"]) el.dispatchEvent(new KeyboardEvent(type,{key,code:key,bubbles:true}));
  return {pressed:true,key};
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
    case "move_mouse": { const tab=await activeTab(); return await runInTab(tab.id,pointTarget,[args.x,args.y,false]); }
    case "click_at": { const tab=await activeTab(); return await runInTab(tab.id,pointTarget,[args.x,args.y,true]); }
    case "inspect_form": { const tab=await activeTab(); return await runInTab(tab.id,inspectForm,[]); }
    case "fill_form": { const tab=await activeTab(); return await runInTab(tab.id,fillForm,[args.fields||[]]); }
    case "press_key": { const tab=await activeTab(); return await runInTab(tab.id,pressKey,[String(args.key||""),args.selector||null]); }
    case "batch_actions": { const results=[]; for(const a of (args.actions||[])){ if(a.command==="batch_actions") throw new Error("Nested batch_actions is not allowed"); results.push(await executeCommand(a.command,a.args||{})); } return {completed:true,count:results.length,results}; }
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
