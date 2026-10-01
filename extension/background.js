let ws = null;
let reconnectTimer = null;
let pingTimer = null;
const EXT_VERSION = "0.8.1";
const domState = new Map();
const cdpAttached = new Set();
const networkState = new Map();

function getNetworkState(tabId){
  if(!networkState.has(tabId)) networkState.set(tabId,{order:[],byId:new Map()});
  return networkState.get(tabId);
}
function trimNetworkState(state,max=500){
  while(state.order.length>max){
    const id=state.order.shift();
    state.byId.delete(id);
  }
}

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
async function targetTab(args={}) {
  if (args.tabId !== undefined && args.tabId !== null) {
    const id=Number(args.tabId);
    if(!Number.isInteger(id)) throw new Error("tabId must be an integer");
    const tab=await chrome.tabs.get(id);
    if(!tab?.id) throw new Error("Tab not found");
    return tab;
  }
  return activeTab();
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function ensureCdp(tabId){
  if(cdpAttached.has(tabId)) return;
  await chrome.debugger.attach({tabId},"1.3");
  cdpAttached.add(tabId);
}
async function cdp(tabId,method,params={}){
  await ensureCdp(tabId);
  return await chrome.debugger.sendCommand({tabId},method,params);
}
chrome.debugger.onDetach.addListener(source=>{ if(source.tabId) cdpAttached.delete(source.tabId); });
chrome.debugger.onEvent.addListener((source,method,params)=>{
  const tabId=source?.tabId;
  if(!tabId || !method?.startsWith("Network.")) return;
  const state=getNetworkState(tabId);
  const id=params?.requestId;
  if(!id) return;
  let row=state.byId.get(id);
  if(method==="Network.requestWillBeSent"){
    row={
      requestId:id,
      url:params.request?.url||"",
      method:params.request?.method||"",
      type:params.type||"",
      startTime:params.timestamp||0,
      initiatorType:params.initiator?.type||"",
      status:null,
      mimeType:null,
      protocol:null,
      fromDiskCache:false,
      fromServiceWorker:false,
      encodedDataLength:0,
      durationMs:null,
      failed:false,
      errorText:null
    };
    state.byId.set(id,row);
    state.order.push(id);
    trimNetworkState(state);
    return;
  }
  if(!row) return;
  if(method==="Network.responseReceived"){
    row.status=params.response?.status??null;
    row.statusText=params.response?.statusText||"";
    row.mimeType=params.response?.mimeType||null;
    row.protocol=params.response?.protocol||null;
    row.fromDiskCache=!!params.response?.fromDiskCache;
    row.fromServiceWorker=!!params.response?.fromServiceWorker;
    row.remoteIPAddress=params.response?.remoteIPAddress||null;
    row.responseTime=params.timestamp||null;
  } else if(method==="Network.loadingFinished"){
    row.encodedDataLength=params.encodedDataLength||0;
    row.endTime=params.timestamp||null;
    if(row.startTime && row.endTime) row.durationMs=Math.max(0,Math.round((row.endTime-row.startTime)*1000));
  } else if(method==="Network.loadingFailed"){
    row.failed=true;
    row.errorText=params.errorText||"";
    row.canceled=!!params.canceled;
    row.blockedReason=params.blockedReason||null;
    row.endTime=params.timestamp||null;
    if(row.startTime && row.endTime) row.durationMs=Math.max(0,Math.round((row.endTime-row.startTime)*1000));
  }
});
function bootstrapPageHelpers() {
  // Functions passed to chrome.scripting.executeScript do not retain the
  // background service worker's lexical scope. Publish the shared helpers
  // into the tab's isolated world before executing commands that reference them.
  globalThis.deepElements = function(selector="*") {
    const out=[]; const seen=new Set();
    const walk=root=>{
      if(!root||seen.has(root)) return; seen.add(root);
      try {
        for(const el of root.querySelectorAll(selector)) out.push(el);
        for(const el of root.querySelectorAll("*")) if(el.shadowRoot) walk(el.shadowRoot);
        for(const frame of root.querySelectorAll("iframe,frame")) {
          try { if(frame.contentDocument) walk(frame.contentDocument); } catch {}
        }
      } catch {}
    };
    walk(document); return [...new Set(out)];
  };

  globalThis.visualCursor = async function(x,y,click=false,cfg={}) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) return false;
  let host=document.getElementById("__cgb_cursor_host");
  if(host && (host.dataset.cgbCursorVersion!=="7" || !host.isConnected)){ try{host.remove();}catch{} host=null; }
  if(!host){
    host=document.createElement("div");
    host.id="__cgb_cursor_host";
    host.dataset.cgbCursorVersion="7";
    host.dataset.cgbX=String(x); host.dataset.cgbY=String(y);
    host.setAttribute("aria-hidden","true");
    const s=host.style;
    s.setProperty("all","initial","important");
    s.setProperty("display","block","important");
    s.setProperty("position","fixed","important");
    s.setProperty("left","0","important"); s.setProperty("top","0","important");
    const cs0=Math.max(18,Math.min(52,Number(cfg.size||30))); s.setProperty("width",cs0+"px","important"); s.setProperty("height",cs0+"px","important");
    s.setProperty("overflow","visible","important"); s.setProperty("pointer-events","none","important");
    s.setProperty("z-index","2147483647","important"); s.setProperty("will-change","transform","important");
    s.setProperty("transform","translate3d("+x+"px,"+y+"px,0)","important");
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    const cs=Math.max(18,Math.min(52,Number(cfg.size||30))); svg.setAttribute("viewBox","0 0 48 48"); svg.setAttribute("width",String(cs)); svg.setAttribute("height",String(cs));
    svg.style.setProperty("display","block","important"); svg.style.setProperty("overflow","visible","important");
    const defs=document.createElementNS("http://www.w3.org/2000/svg","defs");
    const grad=document.createElementNS("http://www.w3.org/2000/svg","linearGradient");
    grad.id="__cgb_cursor_grad_v7"; grad.setAttribute("x1","0"); grad.setAttribute("y1","0"); grad.setAttribute("x2","1"); grad.setAttribute("y2","1");
    [["0%","#9bfbff"],["38%","#39e8f5"],["76%","#16bfd6"],["100%","#087e98"]].forEach(function(pair){
      const st=document.createElementNS("http://www.w3.org/2000/svg","stop"); st.setAttribute("offset",pair[0]); st.setAttribute("stop-color",pair[1]); grad.appendChild(st);
    });
    const filter=document.createElementNS("http://www.w3.org/2000/svg","filter");
    filter.id="__cgb_cursor_shadow_v7"; filter.setAttribute("x","-60%"); filter.setAttribute("y","-60%"); filter.setAttribute("width","220%"); filter.setAttribute("height","220%");
    const ds=document.createElementNS("http://www.w3.org/2000/svg","feDropShadow");
    ds.setAttribute("dx","1.8"); ds.setAttribute("dy","2.4"); ds.setAttribute("stdDeviation","2.2"); ds.setAttribute("flood-color","#002b35"); ds.setAttribute("flood-opacity",".48");
    filter.appendChild(ds); defs.appendChild(grad); defs.appendChild(filter); svg.appendChild(defs);
    const g=document.createElementNS("http://www.w3.org/2000/svg","g"); g.setAttribute("filter","url(#__cgb_cursor_shadow_v7)");
    const ring=document.createElementNS("http://www.w3.org/2000/svg","circle");
    ring.setAttribute("cx","11"); ring.setAttribute("cy","11"); ring.setAttribute("r","8.4"); ring.setAttribute("fill","url(#__cgb_cursor_grad_v7)"); ring.setAttribute("stroke","#063542"); ring.setAttribute("stroke-width","2.2"); g.appendChild(ring);
    const hole=document.createElementNS("http://www.w3.org/2000/svg","circle");
    hole.setAttribute("cx","11"); hole.setAttribute("cy","11"); hole.setAttribute("r","4.2"); hole.setAttribute("fill","#12343c"); g.appendChild(hole);
    const shaft=document.createElementNS("http://www.w3.org/2000/svg","path");
    shaft.setAttribute("d","M15 15 L42 25.2 C44.7 26.3 44.8 30 42.1 31.2 L31 36.1 L24.8 44.1 C23.1 46.3 19.6 45.4 19.2 42.6 Z");
    shaft.setAttribute("fill","url(#__cgb_cursor_grad_v7)"); shaft.setAttribute("stroke","#063542"); shaft.setAttribute("stroke-width","2.2"); shaft.setAttribute("stroke-linejoin","round"); g.appendChild(shaft);
    const shine=document.createElementNS("http://www.w3.org/2000/svg","path");
    shine.setAttribute("d","M18.2 17.2 L38.3 25.2 C39.4 25.7 39.7 27.1 38.5 27.8"); shine.setAttribute("fill","none"); shine.setAttribute("stroke","rgba(255,255,255,.68)"); shine.setAttribute("stroke-width","1.6"); shine.setAttribute("stroke-linecap","round"); g.appendChild(shine);
    svg.appendChild(g); host.appendChild(svg); (document.documentElement||document.body).appendChild(host);
  }
  host.style.setProperty("visibility","visible","important"); host.style.setProperty("opacity","1","important");
  const sx=Number(host.dataset.cgbX), sy=Number(host.dataset.cgbY);
  const startX=Number.isFinite(sx)?sx:x, startY=Number.isFinite(sy)?sy:y;
  const dx=x-startX, dy=y-startY, distance=Math.hypot(dx,dy);
  const speed=Math.max(40,Math.min(300,Number(cfg.speed||180))); const duration=Math.max(40,Math.min(speed,40+distance*(speed/1000))), begin=performance.now();
  await new Promise(function(resolve){
    function step(now){
      const t=Math.min(1,(now-begin)/duration);
      const eased=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      const cx=startX+dx*eased, cy=startY+dy*eased;
      host.style.setProperty("transform","translate3d("+cx+"px,"+cy+"px,0)","important");
      host.dataset.cgbX=String(cx); host.dataset.cgbY=String(cy);
      if(t<1) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
  host.dataset.cgbX=String(x); host.dataset.cgbY=String(y);
  if(click){
    const pulse=document.createElement("div"); pulse.setAttribute("aria-hidden","true");
    const ps=pulse.style; ps.setProperty("position","fixed","important"); ps.setProperty("left",x+"px","important"); ps.setProperty("top",y+"px","important");
    ps.setProperty("width","9px","important"); ps.setProperty("height","9px","important"); ps.setProperty("border","2px solid "+(cfg.clickColor||"#27e9f5"),"important"); ps.setProperty("border-radius","999px","important");
    ps.setProperty("pointer-events","none","important"); ps.setProperty("z-index","2147483646","important"); ps.setProperty("transform","translate(-50%,-50%)","important");
    (document.documentElement||document.body).appendChild(pulse);
    try{ pulse.animate([{transform:"translate(-50%,-50%) scale(.5)",opacity:1},{transform:"translate(-50%,-50%) scale(3.6)",opacity:0}],{duration:360,easing:"ease-out"}).finished.finally(function(){pulse.remove();}); }catch(e){ setTimeout(function(){pulse.remove();},380); }
  }
  return true;
};

  // domDigest calls elementMap by name, so expose it in the same isolated world.
  globalThis.elementMap = function() {
    const clean=s=>(s||"").replace(/\\s+/g," ").trim();
    return globalThis.deepElements("button,a,input,textarea,select,[role='button'],[role='menuitem'],[role='link'],[contenteditable='true'],[tabindex],[onclick]").slice(0,1200).map((el,i)=>{
      if(!el.dataset.cgbId) el.dataset.cgbId="cgb-"+i+"-"+Math.random().toString(36).slice(2,7);
      const r=el.getBoundingClientRect();
      return {elementId:el.dataset.cgbId,tag:el.tagName.toLowerCase(),text:clean(el.innerText||el.getAttribute("aria-label")||el.placeholder||"").slice(0,180),visible:r.width>0&&r.height>0&&r.bottom>=0&&r.right>=0&&r.top<=innerHeight&&r.left<=innerWidth,disabled:!!el.disabled,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
    });
  };
}
async function runInTab(tabId, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, func: bootstrapPageHelpers });
  const [out] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return out?.result;
}
function deepElements(selector="*") {
  const out=[]; const seen=new Set();
  const walk=root=>{
    if(!root||seen.has(root)) return; seen.add(root);
    try {
      for(const el of root.querySelectorAll(selector)) out.push(el);
      for(const el of root.querySelectorAll("*")) if(el.shadowRoot) walk(el.shadowRoot);
      for(const frame of root.querySelectorAll("iframe,frame")) { try { if(frame.contentDocument) walk(frame.contentDocument); } catch {} }
    } catch {}
  };
  walk(document); return [...new Set(out)];
}
function pageSnapshot(maxChars) {
  const clean = s => (s || "").replace(/\s+/g, " ").trim();
  const secret = el => {
    const t=(el.getAttribute?.("type")||"").toLowerCase();
    const ac=(el.getAttribute?.("autocomplete")||"").toLowerCase();
    const n=(el.getAttribute?.("name")||"").toLowerCase();
    return t==="password" || /cc-|cvc|cvv|token|secret|password|passwd|otp|one-time/.test(ac+" "+n);
  };
  const nodes = deepElements("button,a,input,textarea,select,[role='button'],[role='menuitem'],[role='link'],[tabindex],[onclick],[contenteditable='true']").slice(0, 800).map((el,index)=>({
    index, tag: el.tagName.toLowerCase(),
    text: clean(el.innerText || (secret(el)?"[REDACTED]":el.value) || el.getAttribute("aria-label") || el.getAttribute("title") || "").slice(0,240),
    id: el.id || null, name: el.getAttribute("name"), role: el.getAttribute("role"),
    type: el.getAttribute("type"), placeholder: el.getAttribute("placeholder")
  }));
  return { title: document.title, url: location.href, text: clean(document.body?.innerText || "").slice(0,maxChars), interactive:nodes };
}
function clickTarget(selector,text) {
  let el = selector ? document.querySelector(selector) : null;
  if (!el && text) {
    const target=text.toLowerCase().trim();
    const candidates=deepElements("button,a,[role='button'],[role='menuitem'],[role='link'],[tabindex],[onclick],input[type='button'],input[type='submit']");
    el=candidates.find(x=>((x.innerText||x.value||x.getAttribute("aria-label")||"").trim().toLowerCase()===target)) ||
       candidates.find(x=>((x.innerText||x.value||x.getAttribute("aria-label")||"").trim().toLowerCase().includes(target)));
  }
  if(!el && text) {
    const target=text.toLowerCase().trim();
    const all=deepElements("*").filter(x=>{ const r=x.getBoundingClientRect?.(); return r&&r.width>0&&r.height>0; });
    el=all.find(x=>((x.innerText||x.textContent||x.getAttribute?.("aria-label")||"").replace(/\s+/g," ").trim().toLowerCase()===target)) ||
       all.find(x=>((x.innerText||x.textContent||x.getAttribute?.("aria-label")||"").replace(/\s+/g," ").trim().toLowerCase().includes(target)));
  }
  if(!el) throw new Error("Clickable element not found");
  el.scrollIntoView?.({block:"center",inline:"center"});
  const clickable=el.closest?.("button,a,[role='button'],[role='menuitem'],[role='link'],[onclick],[tabindex]")||el;
  clickable.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerType:"mouse"}));
  clickable.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,view:window}));
  clickable.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,view:window}));
  clickable.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerType:"mouse"}));
  clickable.click();
  return {clicked:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||"").trim().slice(0,200)};
}
function typeTarget(selector,text,clearFirst) {
  const el=document.querySelector(selector); if(!el) throw new Error("Input element not found"); el.focus();
  if("value" in el){ if(clearFirst) el.value=""; el.value=clearFirst?text:(el.value||"")+text; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
  else if(el.isContentEditable){ if(clearFirst) el.textContent=""; el.textContent=clearFirst?text:(el.textContent||"")+text; el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text})); }
  else throw new Error("Target is not editable");
  return {typed:true};
}


async function visualCursor(x,y,click=false,cfg={}) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) return false;
  let host=document.getElementById("__cgb_cursor_host");
  if(host && (host.dataset.cgbCursorVersion!=="7" || !host.isConnected)){ try{host.remove();}catch{} host=null; }
  if(!host){
    host=document.createElement("div");
    host.id="__cgb_cursor_host";
    host.dataset.cgbCursorVersion="7";
    host.dataset.cgbX=String(x); host.dataset.cgbY=String(y);
    host.setAttribute("aria-hidden","true");
    const s=host.style;
    s.setProperty("all","initial","important");
    s.setProperty("display","block","important");
    s.setProperty("position","fixed","important");
    s.setProperty("left","0","important"); s.setProperty("top","0","important");
    const cs0=Math.max(18,Math.min(52,Number(cfg.size||30))); s.setProperty("width",cs0+"px","important"); s.setProperty("height",cs0+"px","important");
    s.setProperty("overflow","visible","important"); s.setProperty("pointer-events","none","important");
    s.setProperty("z-index","2147483647","important"); s.setProperty("will-change","transform","important");
    s.setProperty("transform","translate3d("+x+"px,"+y+"px,0)","important");
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    const cs=Math.max(18,Math.min(52,Number(cfg.size||30))); svg.setAttribute("viewBox","0 0 48 48"); svg.setAttribute("width",String(cs)); svg.setAttribute("height",String(cs));
    svg.style.setProperty("display","block","important"); svg.style.setProperty("overflow","visible","important");
    const defs=document.createElementNS("http://www.w3.org/2000/svg","defs");
    const grad=document.createElementNS("http://www.w3.org/2000/svg","linearGradient");
    grad.id="__cgb_cursor_grad_v7"; grad.setAttribute("x1","0"); grad.setAttribute("y1","0"); grad.setAttribute("x2","1"); grad.setAttribute("y2","1");
    [["0%","#9bfbff"],["38%","#39e8f5"],["76%","#16bfd6"],["100%","#087e98"]].forEach(function(pair){
      const st=document.createElementNS("http://www.w3.org/2000/svg","stop"); st.setAttribute("offset",pair[0]); st.setAttribute("stop-color",pair[1]); grad.appendChild(st);
    });
    const filter=document.createElementNS("http://www.w3.org/2000/svg","filter");
    filter.id="__cgb_cursor_shadow_v7"; filter.setAttribute("x","-60%"); filter.setAttribute("y","-60%"); filter.setAttribute("width","220%"); filter.setAttribute("height","220%");
    const ds=document.createElementNS("http://www.w3.org/2000/svg","feDropShadow");
    ds.setAttribute("dx","1.8"); ds.setAttribute("dy","2.4"); ds.setAttribute("stdDeviation","2.2"); ds.setAttribute("flood-color","#002b35"); ds.setAttribute("flood-opacity",".48");
    filter.appendChild(ds); defs.appendChild(grad); defs.appendChild(filter); svg.appendChild(defs);
    const g=document.createElementNS("http://www.w3.org/2000/svg","g"); g.setAttribute("filter","url(#__cgb_cursor_shadow_v7)");
    const ring=document.createElementNS("http://www.w3.org/2000/svg","circle");
    ring.setAttribute("cx","11"); ring.setAttribute("cy","11"); ring.setAttribute("r","8.4"); ring.setAttribute("fill","url(#__cgb_cursor_grad_v7)"); ring.setAttribute("stroke","#063542"); ring.setAttribute("stroke-width","2.2"); g.appendChild(ring);
    const hole=document.createElementNS("http://www.w3.org/2000/svg","circle");
    hole.setAttribute("cx","11"); hole.setAttribute("cy","11"); hole.setAttribute("r","4.2"); hole.setAttribute("fill","#12343c"); g.appendChild(hole);
    const shaft=document.createElementNS("http://www.w3.org/2000/svg","path");
    shaft.setAttribute("d","M15 15 L42 25.2 C44.7 26.3 44.8 30 42.1 31.2 L31 36.1 L24.8 44.1 C23.1 46.3 19.6 45.4 19.2 42.6 Z");
    shaft.setAttribute("fill","url(#__cgb_cursor_grad_v7)"); shaft.setAttribute("stroke","#063542"); shaft.setAttribute("stroke-width","2.2"); shaft.setAttribute("stroke-linejoin","round"); g.appendChild(shaft);
    const shine=document.createElementNS("http://www.w3.org/2000/svg","path");
    shine.setAttribute("d","M18.2 17.2 L38.3 25.2 C39.4 25.7 39.7 27.1 38.5 27.8"); shine.setAttribute("fill","none"); shine.setAttribute("stroke","rgba(255,255,255,.68)"); shine.setAttribute("stroke-width","1.6"); shine.setAttribute("stroke-linecap","round"); g.appendChild(shine);
    svg.appendChild(g); host.appendChild(svg); (document.documentElement||document.body).appendChild(host);
  }
  host.style.setProperty("visibility","visible","important"); host.style.setProperty("opacity","1","important");
  const sx=Number(host.dataset.cgbX), sy=Number(host.dataset.cgbY);
  const startX=Number.isFinite(sx)?sx:x, startY=Number.isFinite(sy)?sy:y;
  const dx=x-startX, dy=y-startY, distance=Math.hypot(dx,dy);
  const speed=Math.max(40,Math.min(300,Number(cfg.speed||180))); const duration=Math.max(40,Math.min(speed,40+distance*(speed/1000))), begin=performance.now();
  await new Promise(function(resolve){
    function step(now){
      const t=Math.min(1,(now-begin)/duration);
      const eased=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
      const cx=startX+dx*eased, cy=startY+dy*eased;
      host.style.setProperty("transform","translate3d("+cx+"px,"+cy+"px,0)","important");
      host.dataset.cgbX=String(cx); host.dataset.cgbY=String(cy);
      if(t<1) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
  host.dataset.cgbX=String(x); host.dataset.cgbY=String(y);
  if(click){
    const pulse=document.createElement("div"); pulse.setAttribute("aria-hidden","true");
    const ps=pulse.style; ps.setProperty("position","fixed","important"); ps.setProperty("left",x+"px","important"); ps.setProperty("top",y+"px","important");
    ps.setProperty("width","9px","important"); ps.setProperty("height","9px","important"); ps.setProperty("border","2px solid "+(cfg.clickColor||"#27e9f5"),"important"); ps.setProperty("border-radius","999px","important");
    ps.setProperty("pointer-events","none","important"); ps.setProperty("z-index","2147483646","important"); ps.setProperty("transform","translate(-50%,-50%)","important");
    (document.documentElement||document.body).appendChild(pulse);
    try{ pulse.animate([{transform:"translate(-50%,-50%) scale(.5)",opacity:1},{transform:"translate(-50%,-50%) scale(3.6)",opacity:0}],{duration:360,easing:"ease-out"}).finished.finally(function(){pulse.remove();}); }catch(e){ setTimeout(function(){pulse.remove();},380); }
  }
  return true;
}
async function pointTarget(x,y,clickIt,cfg={}) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error("x/y must be numbers");
  if(cfg.enabled!==false) await visualCursor(x,y,!!clickIt&&cfg.clickEffect!==false,cfg);
  let el=document.elementFromPoint(x,y);
  if(!el) return {moved:true,clicked:false,x,y,visualCursor:true,targetFound:false};
  const init={bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,button:0,pointerType:"mouse"};
  el.dispatchEvent(new PointerEvent("pointermove",init)); el.dispatchEvent(new MouseEvent("mousemove",init)); el.dispatchEvent(new MouseEvent("mouseover",init));
  if(clickIt){
    el.dispatchEvent(new PointerEvent("pointerdown",init)); el.dispatchEvent(new MouseEvent("mousedown",init));
    el.dispatchEvent(new PointerEvent("pointerup",init)); el.dispatchEvent(new MouseEvent("mouseup",init)); el.dispatchEvent(new MouseEvent("click",init));
    try{el.click();}catch(e){}
  }
  const r=el.getBoundingClientRect();
  return {moved:true,clicked:!!clickIt,x,y,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||el.getAttribute("aria-label")||"").trim().slice(0,160),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
}
async function drawPath(points,opts){
  opts=opts||{};
  const pts=(Array.isArray(points)?points:[]).slice(0,2400).map(function(p){return{x:Number(p.x),y:Number(p.y)};}).filter(function(p){return Number.isFinite(p.x)&&Number.isFinite(p.y);});
  if(pts.length<2) throw new Error("draw_path needs at least two valid points");
  const closed=!!opts.closed, clear=!!opts.clear, stroke=String(opts.stroke||"#23d9ea").slice(0,40), fill=String(opts.fill||"none").slice(0,40);
  const width=Math.max(1,Math.min(24,Number(opts.width||4))), duration=Math.max(120,Math.min(12000,Number(opts.durationMs||Math.min(4500,220+pts.length*14))));
  let layer=document.getElementById("__cgb_draw_layer");
  if(!layer){
    layer=document.createElementNS("http://www.w3.org/2000/svg","svg"); layer.id="__cgb_draw_layer"; layer.setAttribute("aria-hidden","true");
    const s=layer.style; s.setProperty("position","fixed","important"); s.setProperty("inset","0","important"); s.setProperty("width","100%","important"); s.setProperty("height","100%","important");
    s.setProperty("pointer-events","none","important"); s.setProperty("z-index","2147483645","important"); s.setProperty("overflow","visible","important");
    (document.documentElement||document.body).appendChild(layer);
  }
  layer.setAttribute("viewBox","0 0 "+innerWidth+" "+innerHeight); if(clear) layer.replaceChildren();
  const d=pts.map(function(p,i){return(i?"L":"M")+p.x+" "+p.y;}).join(" ")+(closed?" Z":"");
  const path=document.createElementNS("http://www.w3.org/2000/svg","path");
  path.setAttribute("d",d); path.setAttribute("fill","none"); path.setAttribute("stroke",stroke); path.setAttribute("stroke-width",String(width)); path.setAttribute("stroke-linecap","round"); path.setAttribute("stroke-linejoin","round");
  layer.appendChild(path);
  const length=Math.max(1,path.getTotalLength()); path.style.strokeDasharray=String(length); path.style.strokeDashoffset=String(length);
  await visualCursor(pts[0].x,pts[0].y,false);
  const host=document.getElementById("__cgb_cursor_host"), begin=performance.now();
  await new Promise(function(resolve){
    function step(now){
      const t=Math.min(1,(now-begin)/duration), eased=t*t*(3-2*t); path.style.strokeDashoffset=String(length*(1-eased));
      const p=path.getPointAtLength(length*eased);
      if(host){ host.style.setProperty("transform","translate3d("+p.x+"px,"+p.y+"px,0)","important"); host.dataset.cgbX=String(p.x); host.dataset.cgbY=String(p.y); }
      if(t<1) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
  path.style.strokeDashoffset="0"; if(closed&&fill!=="none") path.setAttribute("fill",fill);
  return {drawn:true,points:pts.length,closed:closed,stroke:stroke,width:width,durationMs:duration};
}
function clearDrawings(){ const layer=document.getElementById("__cgb_draw_layer"); if(layer) layer.remove(); return {cleared:true}; }
function inspectForm() {
  const clean=s=>(s||"").replace(/\s+/g," ").trim();
  const fields=[...document.querySelectorAll("input,textarea,select,[contenteditable='true']")].filter(el=>el.type!=="hidden").slice(0,300).map((el,index)=>{
    const id=el.id||""; const label=(id&&document.querySelector('label[for="'+CSS.escape(id)+'"]')) || el.closest("label");
    const r=el.getBoundingClientRect();
    const sensitive=(el.type==="password"||/cc-|cvc|cvv|token|secret|password|passwd|otp|one-time/i.test((el.autocomplete||"")+" "+(el.name||"")));
    return {index,tag:el.tagName.toLowerCase(),type:el.type||null,id:id||null,name:el.name||null,label:clean(label?.innerText),placeholder:el.placeholder||null,ariaLabel:el.getAttribute("aria-label"),value:sensitive?"[REDACTED]":(el.value??el.textContent??""),required:!!el.required,disabled:!!el.disabled,options:el.tagName==="SELECT"?[...el.options].map(o=>({value:o.value,text:clean(o.text)})).slice(0,100):undefined,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
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


function elementMap() {
  const clean=s=>(s||"").replace(/\s+/g," ").trim();
  return deepElements("button,a,input,textarea,select,[role='button'],[role='menuitem'],[role='link'],[contenteditable='true'],[tabindex],[onclick]").slice(0,1200).map((el,i)=>{
    if(!el.dataset.cgbId) el.dataset.cgbId="cgb-"+i+"-"+Math.random().toString(36).slice(2,7);
    const r=el.getBoundingClientRect();
    return {elementId:el.dataset.cgbId,tag:el.tagName.toLowerCase(),text:clean(el.innerText||el.getAttribute("aria-label")||el.placeholder||"").slice(0,180),visible:r.width>0&&r.height>0&&r.bottom>=0&&r.right>=0&&r.top<=innerHeight&&r.left<=innerWidth,disabled:!!el.disabled,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  });
}
function viewportInfo(){ return {url:location.href,title:document.title,width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}; }
function domDigest(maxChars=40000){
  const text=(document.body?.innerText||"").replace(/\s+/g," ").trim().slice(0,maxChars);
  const interactive=elementMap();
  return {url:location.href,title:document.title,text,interactive,at:Date.now()};
}
async function mouseAction(kind,x,y,button="left"){
  x=Number(x); y=Number(y); await visualCursor(x,y,kind==="double"||kind==="right"||kind==="mousedown"||kind==="mouseup");
  const el=document.elementFromPoint(x,y); if(!el) return {ok:true,kind:kind,x:x,y:y,visualCursor:true,targetFound:false};
  const btn=button==="right"?2:button==="middle"?1:0, init={bubbles:true,cancelable:true,clientX:x,clientY:y,button:btn,view:window,pointerType:"mouse"};
  if(kind==="double"){ for(let i=0;i<2;i++){el.dispatchEvent(new PointerEvent("pointerdown",init));el.dispatchEvent(new MouseEvent("mousedown",init));el.dispatchEvent(new PointerEvent("pointerup",init));el.dispatchEvent(new MouseEvent("mouseup",init));el.dispatchEvent(new MouseEvent("click",Object.assign({},init,{detail:i+1})));} el.dispatchEvent(new MouseEvent("dblclick",Object.assign({},init,{detail:2}))); }
  else if(kind==="right"){ el.dispatchEvent(new MouseEvent("contextmenu",Object.assign({},init,{button:2}))); }
  else { if(kind.startsWith("mouse")) el.dispatchEvent(new MouseEvent(kind,init)); else el.dispatchEvent(new PointerEvent(kind,init)); }
  return {ok:true,kind:kind,tag:el.tagName.toLowerCase(),x:x,y:y};
}

async function nativeMousePath(tabId, points, options={}) {
  const pts=(Array.isArray(points)?points:[]).slice(0,3000).map(p=>({x:Number(p.x),y:Number(p.y)})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
  if(pts.length<2) throw new Error("native_mouse_path needs at least two valid points");
  await ensureCdp(tabId);
  const duration=Math.max(40,Math.min(15000,Number(options.durationMs||700)));
  const press=options.press!==false;
  const release=options.release!==false;
  const button=String(options.button||"left");
  const buttons=button==="right"?2:button==="middle"?4:1;
  const start=pts[0];
  await chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type:"mouseMoved",x:start.x,y:start.y,button:"none",buttons:0});
  if(press) await chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type:"mousePressed",x:start.x,y:start.y,button,buttons,clickCount:1});
  const segs=[]; let total=0;
  for(let i=1;i<pts.length;i++){ const d=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y); segs.push(d); total+=d; }
  total=Math.max(total,1);
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1], b=pts[i], seg=segs[i-1];
    const steps=Math.max(2,Math.min(80,Math.round(seg/8)));
    for(let s=1;s<=steps;s++){
      const t=s/steps, x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
      await chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type:"mouseMoved",x,y,button:press?button:"none",buttons:press?buttons:0});
      await sleep(Math.max(1,Math.round(duration*(seg/total)/steps)));
    }
  }
  const end=pts[pts.length-1];
  if(press&&release) await chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type:"mouseReleased",x:end.x,y:end.y,button,buttons:0,clickCount:1});
  await runInTab(tabId,visualCursor,[end.x,end.y,false]).catch(()=>{});
  return {ok:true,points:pts.length,durationMs:duration,pressed:press,released:release};
}

function dragDrop(fromX,fromY,toX,toY){
  const src=document.elementFromPoint(Number(fromX),Number(fromY)), dst=document.elementFromPoint(Number(toX),Number(toY));
  if(!src||!dst) throw new Error("Drag source/target not found");
  const dt=new DataTransfer();
  src.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:dt,clientX:Number(fromX),clientY:Number(fromY)}));
  dst.dispatchEvent(new DragEvent("dragenter",{bubbles:true,dataTransfer:dt,clientX:Number(toX),clientY:Number(toY)}));
  dst.dispatchEvent(new DragEvent("dragover",{bubbles:true,dataTransfer:dt,clientX:Number(toX),clientY:Number(toY)}));
  dst.dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:dt,clientX:Number(toX),clientY:Number(toY)}));
  src.dispatchEvent(new DragEvent("dragend",{bubbles:true,dataTransfer:dt,clientX:Number(toX),clientY:Number(toY)}));
  return {dragged:true};
}
function keyCombo(keys,selector){
  const el=selector?document.querySelector(selector):document.activeElement||document.body; if(!el) throw new Error("Key target not found");
  el.focus?.(); const arr=Array.isArray(keys)?keys:[keys]; const mods={ctrlKey:arr.includes("Control"),shiftKey:arr.includes("Shift"),altKey:arr.includes("Alt"),metaKey:arr.includes("Meta")};
  for(const k of arr) el.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true,...mods}));
  for(const k of [...arr].reverse()) el.dispatchEvent(new KeyboardEvent("keyup",{key:k,bubbles:true,...mods}));
  return {pressed:true,keys:arr};
}
function findCondition(selector,text){
  const el=selector?document.querySelector(selector):null;
  if(selector) return !!el;
  if(text) return (document.body?.innerText||"").includes(text);
  return document.readyState==="complete";
}

function scrollPage(x,y,behavior) { window.scrollBy({left:x,top:y,behavior:behavior||"smooth"}); return {scrolled:true,x:window.scrollX,y:window.scrollY}; }
function hoverTarget(selector,text) { let el=selector?document.querySelector(selector):null; if(!el&&text){const q=text.toLowerCase();el=[...document.querySelectorAll("a,button,input,select,textarea,[role='button'],*")].find(e=>(e.innerText||e.value||"").trim().toLowerCase().includes(q));} if(!el) throw new Error("Element not found"); el.scrollIntoView({block:"center"}); el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true})); el.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true})); return {hovered:true}; }
function selectTarget(selector,value) { const el=document.querySelector(selector); if(!el||el.tagName!=="SELECT") throw new Error("Select element not found"); el.value=value; el.dispatchEvent(new Event("change",{bubbles:true})); return {selected:true,value:el.value}; }

async function executeCommand(command,args={}){
  const tab=async()=>await targetTab(args);
  switch(command){
    case "bridge_info": { const t=await activeTab().catch(()=>null); return {extensionVersion:EXT_VERSION,connected:ws?.readyState===WebSocket.OPEN,activeTabId:t?.id||null,cdpAttached:[...cdpAttached],capabilities:["tabId","live_dom","dom_diff","deep_dom","shadow_dom","same_origin_iframes","element_map","viewport","wait_for","mouse_advanced","smooth_cursor","freehand_draw","native_mouse_path","keyboard_combo","drag_drop","zoom","parallel_actions","cdp","screenshots","forms","click_fallback"]}; }
    case "get_page": { const t=await tab(); const result=await runInTab(t.id,pageSnapshot,[Math.min(Math.max(Number(args.maxChars||30000),1000),100000)]); return {tabId:t.id,...result}; }
    case "get_viewport": { const t=await tab(); return {tabId:t.id,...await runInTab(t.id,viewportInfo,[])}; }
    case "element_map": { const t=await tab(); return {tabId:t.id,elements:await runInTab(t.id,elementMap,[])}; }
    case "dom_watch": { const t=await tab(); const snap=await runInTab(t.id,domDigest,[Math.min(Math.max(Number(args.maxChars||40000),1000),100000)]); const prev=domState.get(t.id); domState.set(t.id,snap); return {tabId:t.id,changed:!prev||prev.url!==snap.url||prev.text!==snap.text,previousAt:prev?.at||null,current:snap}; }
    case "dom_diff": { const t=await tab(); const snap=await runInTab(t.id,domDigest,[Math.min(Math.max(Number(args.maxChars||40000),1000),100000)]); const prev=domState.get(t.id); domState.set(t.id,snap); if(!prev) return {tabId:t.id,baselineCreated:true,current:snap}; const oldSet=new Set(prev.interactive.map(x=>x.elementId+"|"+x.text)); const newSet=new Set(snap.interactive.map(x=>x.elementId+"|"+x.text)); return {tabId:t.id,urlChanged:prev.url!==snap.url,textChanged:prev.text!==snap.text,added:[...newSet].filter(x=>!oldSet.has(x)).slice(0,200),removed:[...oldSet].filter(x=>!newSet.has(x)).slice(0,200),at:snap.at}; }
    case "wait_for": { const t=await tab(); const timeout=Math.min(Math.max(Number(args.timeoutMs||10000),100),60000), interval=Math.min(Math.max(Number(args.intervalMs||250),50),2000), began=Date.now(); while(Date.now()-began<timeout){ if(await runInTab(t.id,findCondition,[args.selector||null,args.text||null])) return {found:true,tabId:t.id,elapsedMs:Date.now()-began}; await sleep(interval); } throw new Error("wait_for timed out"); }
    case "click": { const t=await tab(); return await runInTab(t.id,clickTarget,[args.selector||null,args.text||null]); }
    case "type": { const t=await tab(); return await runInTab(t.id,typeTarget,[args.selector,String(args.text??""),args.clearFirst!==false]); }
    case "navigate": { const t=await tab(); await chrome.tabs.update(t.id,{url:args.url}); return {navigated:true,tabId:t.id,url:args.url}; }
    case "move_mouse": { const t=await tab(); const s=await chrome.storage.local.get(["cursorSize","cursorSpeed","cursorColor","clickColor","cursorEnabled","clickEffect"]); return await runInTab(t.id,pointTarget,[args.x,args.y,false,{size:s.cursorSize||30,speed:s.cursorSpeed||180,color:s.cursorColor||"#27e9f5",clickColor:s.clickColor||"#27e9f5",enabled:s.cursorEnabled!==false,clickEffect:s.clickEffect!==false}]); }
    case "click_at": { const t=await tab(); const s=await chrome.storage.local.get(["cursorSize","cursorSpeed","cursorColor","clickColor","cursorEnabled","clickEffect"]); return await runInTab(t.id,pointTarget,[args.x,args.y,true,{size:s.cursorSize||30,speed:s.cursorSpeed||180,color:s.cursorColor||"#27e9f5",clickColor:s.clickColor||"#27e9f5",enabled:s.cursorEnabled!==false,clickEffect:s.clickEffect!==false}]); }
    case "mouse_action": { const t=await tab(); return await runInTab(t.id,mouseAction,[args.kind,args.x,args.y,args.button||"left"]); }
    case "draw_path": { const t=await tab(); return await runInTab(t.id,drawPath,[args.points||[],args.options||{}]); }
    case "native_mouse_path": { const t=await tab(); return await nativeMousePath(t.id,args.points||[],args.options||{}); }
    case "clear_drawings": { const t=await tab(); return await runInTab(t.id,clearDrawings,[]); }
    case "drag_drop": { const t=await tab(); return await runInTab(t.id,dragDrop,[args.fromX,args.fromY,args.toX,args.toY]); }
    case "inspect_form": { const t=await tab(); return await runInTab(t.id,inspectForm,[]); }
    case "fill_form": { const t=await tab(); return await runInTab(t.id,fillForm,[args.fields||[]]); }
    case "press_key": { const t=await tab(); return await runInTab(t.id,pressKey,[String(args.key||""),args.selector||null]); }
    case "key_combo": { const t=await tab(); return await runInTab(t.id,keyCombo,[args.keys||[],args.selector||null]); }
    case "zoom": { const t=await tab(); const factor=Number(args.factor); if(!(factor===0||(factor>=0.25&&factor<=5))) throw new Error("zoom factor must be 0 or 0.25..5"); await chrome.tabs.setZoom(t.id,factor); return {tabId:t.id,zoom:await chrome.tabs.getZoom(t.id)}; }
    case "batch_actions": { const results=[]; for(const a of (args.actions||[])){ if(["batch_actions","parallel_actions"].includes(a.command)) throw new Error("Nested batch/parallel is not allowed"); results.push(await executeCommand(a.command,a.args||{})); } return {completed:true,count:results.length,results}; }
    case "parallel_actions": { const acts=args.actions||[]; const results=await Promise.all(acts.map(a=>{if(["batch_actions","parallel_actions"].includes(a.command)) throw new Error("Nested batch/parallel is not allowed"); return executeCommand(a.command,a.args||{});})); return {completed:true,count:results.length,results}; }
    case "screenshot": { const t=await tab(); if(!t.active) throw new Error("Screenshot capture requires the target tab to be active in its window"); const dataUrl=await chrome.tabs.captureVisibleTab(t.windowId,{format:"png"}); const metrics=await runInTab(t.id,viewportInfo,[]); return {tabId:t.id,dataUrl,...metrics}; }
    case "list_tabs": { const tabs=await chrome.tabs.query({currentWindow:true}); return tabs.map(t=>({id:t.id,active:t.active,title:t.title,url:t.url,status:t.status})); }
    case "activate_tab": { const tabId=Number(args.tabId); if(!Number.isInteger(tabId)) throw new Error("tabId must be an integer"); await chrome.tabs.update(tabId,{active:true}); return {activated:true,tabId}; }
    case "new_tab": { const t=await chrome.tabs.create({url:args.url||"about:blank",active:args.active!==false}); return {created:true,tabId:t.id,url:t.url}; }
    case "close_tab": { const t=await tab(); await chrome.tabs.remove(t.id); domState.delete(t.id); return {closed:true,tabId:t.id}; }
    case "duplicate_tab": { const t=await tab(); const n=await chrome.tabs.duplicate(t.id); return {duplicated:true,tabId:n.id}; }
    case "reload": { const t=await tab(); await chrome.tabs.reload(t.id,{bypassCache:!!args.bypassCache}); return {reloaded:true,tabId:t.id}; }
    case "go_back": { const t=await tab(); await chrome.tabs.goBack(t.id); return {back:true,tabId:t.id}; }
    case "go_forward": { const t=await tab(); await chrome.tabs.goForward(t.id); return {forward:true,tabId:t.id}; }
    case "scroll": { const t=await tab(); return await runInTab(t.id,scrollPage,[Number(args.x||0),Number(args.y||0),args.behavior||"smooth"]); }
    case "hover": { const t=await tab(); return await runInTab(t.id,hoverTarget,[args.selector||null,args.text||null]); }
    case "select": { const t=await tab(); return await runInTab(t.id,selectTarget,[args.selector,String(args.value)]); }
    case "cdp_attach": { const t=await tab(); await ensureCdp(t.id); await chrome.debugger.sendCommand({tabId:t.id},"Page.enable"); await chrome.debugger.sendCommand({tabId:t.id},"DOM.enable"); await chrome.debugger.sendCommand({tabId:t.id},"Network.enable"); return {attached:true,tabId:t.id}; }
    case "cdp_detach": { const t=await tab(); if(cdpAttached.has(t.id)) await chrome.debugger.detach({tabId:t.id}); cdpAttached.delete(t.id); return {detached:true,tabId:t.id}; }
    case "cdp_status": { const t=await tab(); const targets=await chrome.debugger.getTargets(); const info=targets.find(x=>x.tabId===t.id); return {tabId:t.id,attached:!!info?.attached,title:info?.title,url:info?.url}; }
    case "network_logs": {
      const t=await tab();
      await ensureCdp(t.id);
      await chrome.debugger.sendCommand({tabId:t.id},"Network.enable");
      const state=getNetworkState(t.id);
      const limit=Math.max(1,Math.min(200,Number(args.limit||50)));
      const requests=state.order.slice(-limit).map(id=>state.byId.get(id)).filter(Boolean);
      const result={tabId:t.id,title:t.title,url:t.url,count:requests.length,requests};
      if(args.clear===true){ state.order=[]; state.byId.clear(); }
      return result;
    }
    case "cdp_command": { const t=await tab(); const method=String(args.method||""); const allowed=/^(Page\.(enable|getLayoutMetrics|captureScreenshot)|DOM\.(enable|getDocument|getOuterHTML)|DOMSnapshot\.captureSnapshot|Network\.(enable|getResponseBody)|Performance\.(enable|getMetrics)|Runtime\.getIsolateId|Input\.(dispatchMouseEvent|dispatchKeyEvent))$/.test(method); if(!allowed) throw new Error("CDP method not allowed by bridge safety policy"); return {tabId:t.id,method,result:await cdp(t.id,method,args.params||{})}; }
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
