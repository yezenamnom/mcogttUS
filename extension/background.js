let ws = null;
let reconnectTimer = null;
let pingTimer = null;
const EXT_VERSION = "0.6.6";
const domState = new Map();
const cdpAttached = new Set();

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
  await chrome.debugger.attach({tabId},"0.1");
  cdpAttached.add(tabId);
}
async function cdp(tabId,method,params={}){
  await ensureCdp(tabId);
  return await chrome.debugger.sendCommand({tabId},method,params);
}
chrome.debugger.onDetach.addListener(source=>{ if(source.tabId) cdpAttached.delete(source.tabId); });
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

  globalThis.visualCursor = function(x,y,click=false) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) return false;

  let host=document.getElementById("__cgb_cursor_host");
  if(host && host.dataset.cgbCursorVersion!=="4"){
    try{ host.remove(); }catch{}
    host=null;
  }

  if(!host){
    host=document.createElement("div");
    host.id="__cgb_cursor_host";
    host.dataset.cgbCursorVersion="4";
    host.setAttribute("aria-hidden","true");
    const s=host.style;
    s.setProperty("all","initial","important");
    s.setProperty("display","block","important");
    s.setProperty("position","fixed","important");
    s.setProperty("width","22px","important");
    s.setProperty("height","27px","important");
    s.setProperty("margin","0","important");
    s.setProperty("padding","0","important");
    s.setProperty("overflow","visible","important");
    s.setProperty("pointer-events","none","important");
    s.setProperty("z-index","2147483647","important");
    s.setProperty("transition","left .13s cubic-bezier(.2,.8,.2,1), top .13s cubic-bezier(.2,.8,.2,1)","important");
    s.setProperty("will-change","left,top","important");

    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 28 34");
    svg.setAttribute("width","22");
    svg.setAttribute("height","27");
    svg.style.setProperty("display","block","important");
    svg.style.setProperty("overflow","visible","important");
    svg.style.setProperty("transform-origin","35% 28%","important");

    const defs=document.createElementNS("http://www.w3.org/2000/svg","defs");
    const grad=document.createElementNS("http://www.w3.org/2000/svg","linearGradient");
    grad.id="__cgb_cursor_grad";
    grad.setAttribute("x1","0"); grad.setAttribute("y1","0"); grad.setAttribute("x2","1"); grad.setAttribute("y2","1");
    [["0%","#d9fbff"],["34%","#43e5ff"],["68%","#38a7ff"],["100%","#8a5cff"]].forEach(([o,c])=>{
      const st=document.createElementNS("http://www.w3.org/2000/svg","stop");
      st.setAttribute("offset",o); st.setAttribute("stop-color",c); grad.appendChild(st);
    });
    defs.appendChild(grad); svg.appendChild(defs);

    const shadow=document.createElementNS("http://www.w3.org/2000/svg","path");
    shadow.setAttribute("d","M2 1.5v25.2l6.8-6.4 4.7 10.7 5.2-2.4-4.7-10.3h10.2L2 1.5Z");
    shadow.setAttribute("fill","rgba(0,20,35,.32)");
    shadow.setAttribute("transform","translate(1.6 2.1)");
    svg.appendChild(shadow);

    const path=document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d","M2 1.5v25.2l6.8-6.4 4.7 10.7 5.2-2.4-4.7-10.3h10.2L2 1.5Z");
    path.setAttribute("fill","url(#__cgb_cursor_grad)");
    path.setAttribute("stroke","#07131c");
    path.setAttribute("stroke-width","1.7");
    path.setAttribute("stroke-linejoin","round");
    svg.appendChild(path);

    const shine=document.createElementNS("http://www.w3.org/2000/svg","path");
    shine.setAttribute("d","M4.4 5.2v14.1l3.8-3.5");
    shine.setAttribute("fill","none");
    shine.setAttribute("stroke","rgba(255,255,255,.72)");
    shine.setAttribute("stroke-width","1.2");
    shine.setAttribute("stroke-linecap","round");
    svg.appendChild(shine);

    host.appendChild(svg);
    (document.documentElement||document.body).appendChild(host);

    try{
      svg.animate(
        [
          {filter:"drop-shadow(0 1px 2px rgba(0,0,0,.45)) hue-rotate(0deg)",transform:"rotate(-2deg) scale(1)"},
          {filter:"drop-shadow(0 2px 4px rgba(0,220,255,.34)) hue-rotate(90deg)",transform:"rotate(2deg) scale(1.03)"},
          {filter:"drop-shadow(0 1px 2px rgba(0,0,0,.45)) hue-rotate(180deg)",transform:"rotate(-2deg) scale(1)"}
        ],
        {duration:2600,iterations:Infinity,easing:"ease-in-out"}
      );
    }catch{}
  }

  host.style.setProperty("left",x+"px","important");
  host.style.setProperty("top",y+"px","important");

  if(click){
    const ring=document.createElement("div");
    ring.setAttribute("aria-hidden","true");
    const rs=ring.style;
    rs.setProperty("position","fixed","important");
    rs.setProperty("left",x+"px","important");
    rs.setProperty("top",y+"px","important");
    rs.setProperty("width","8px","important");
    rs.setProperty("height","8px","important");
    rs.setProperty("border","2px solid #00eaff","important");
    rs.setProperty("border-radius","999px","important");
    rs.setProperty("pointer-events","none","important");
    rs.setProperty("z-index","2147483646","important");
    rs.setProperty("transform","translate(-50%,-50%)","important");
    rs.setProperty("opacity","1","important");
    (document.documentElement||document.body).appendChild(ring);
    try{
      ring.animate(
        [
          {transform:"translate(-50%,-50%) scale(.45)",opacity:1,borderColor:"#00eaff",boxShadow:"0 0 4px #00eaff"},
          {transform:"translate(-50%,-50%) scale(2.2)",opacity:.92,borderColor:"#7c5cff",boxShadow:"0 0 10px #7c5cff"},
          {transform:"translate(-50%,-50%) scale(3.8)",opacity:0,borderColor:"#ff3bd4",boxShadow:"0 0 18px #ff3bd4"}
        ],
        {duration:420,easing:"ease-out"}
      ).finished.finally(()=>ring.remove());
    }catch{ setTimeout(()=>ring.remove(),450); }

    const svg=host.querySelector("svg");
    try{ svg?.animate([{transform:"scale(.86) rotate(-5deg)"},{transform:"scale(1.08) rotate(3deg)"},{transform:"scale(1) rotate(0deg)"}],{duration:220,easing:"ease-out"}); }catch{}
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


function visualCursor(x,y,click=false) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) return false;

  let host=document.getElementById("__cgb_cursor_host");
  if(host && host.dataset.cgbCursorVersion!=="4"){
    try{ host.remove(); }catch{}
    host=null;
  }

  if(!host){
    host=document.createElement("div");
    host.id="__cgb_cursor_host";
    host.dataset.cgbCursorVersion="4";
    host.setAttribute("aria-hidden","true");
    const s=host.style;
    s.setProperty("all","initial","important");
    s.setProperty("display","block","important");
    s.setProperty("position","fixed","important");
    s.setProperty("width","22px","important");
    s.setProperty("height","27px","important");
    s.setProperty("margin","0","important");
    s.setProperty("padding","0","important");
    s.setProperty("overflow","visible","important");
    s.setProperty("pointer-events","none","important");
    s.setProperty("z-index","2147483647","important");
    s.setProperty("transition","left .13s cubic-bezier(.2,.8,.2,1), top .13s cubic-bezier(.2,.8,.2,1)","important");
    s.setProperty("will-change","left,top","important");

    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 28 34");
    svg.setAttribute("width","22");
    svg.setAttribute("height","27");
    svg.style.setProperty("display","block","important");
    svg.style.setProperty("overflow","visible","important");
    svg.style.setProperty("transform-origin","35% 28%","important");

    const defs=document.createElementNS("http://www.w3.org/2000/svg","defs");
    const grad=document.createElementNS("http://www.w3.org/2000/svg","linearGradient");
    grad.id="__cgb_cursor_grad";
    grad.setAttribute("x1","0"); grad.setAttribute("y1","0"); grad.setAttribute("x2","1"); grad.setAttribute("y2","1");
    [["0%","#d9fbff"],["34%","#43e5ff"],["68%","#38a7ff"],["100%","#8a5cff"]].forEach(([o,c])=>{
      const st=document.createElementNS("http://www.w3.org/2000/svg","stop");
      st.setAttribute("offset",o); st.setAttribute("stop-color",c); grad.appendChild(st);
    });
    defs.appendChild(grad); svg.appendChild(defs);

    const shadow=document.createElementNS("http://www.w3.org/2000/svg","path");
    shadow.setAttribute("d","M2 1.5v25.2l6.8-6.4 4.7 10.7 5.2-2.4-4.7-10.3h10.2L2 1.5Z");
    shadow.setAttribute("fill","rgba(0,20,35,.32)");
    shadow.setAttribute("transform","translate(1.6 2.1)");
    svg.appendChild(shadow);

    const path=document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d","M2 1.5v25.2l6.8-6.4 4.7 10.7 5.2-2.4-4.7-10.3h10.2L2 1.5Z");
    path.setAttribute("fill","url(#__cgb_cursor_grad)");
    path.setAttribute("stroke","#07131c");
    path.setAttribute("stroke-width","1.7");
    path.setAttribute("stroke-linejoin","round");
    svg.appendChild(path);

    const shine=document.createElementNS("http://www.w3.org/2000/svg","path");
    shine.setAttribute("d","M4.4 5.2v14.1l3.8-3.5");
    shine.setAttribute("fill","none");
    shine.setAttribute("stroke","rgba(255,255,255,.72)");
    shine.setAttribute("stroke-width","1.2");
    shine.setAttribute("stroke-linecap","round");
    svg.appendChild(shine);

    host.appendChild(svg);
    (document.documentElement||document.body).appendChild(host);

    try{
      svg.animate(
        [
          {filter:"drop-shadow(0 1px 2px rgba(0,0,0,.45)) hue-rotate(0deg)",transform:"rotate(-2deg) scale(1)"},
          {filter:"drop-shadow(0 2px 4px rgba(0,220,255,.34)) hue-rotate(90deg)",transform:"rotate(2deg) scale(1.03)"},
          {filter:"drop-shadow(0 1px 2px rgba(0,0,0,.45)) hue-rotate(180deg)",transform:"rotate(-2deg) scale(1)"}
        ],
        {duration:2600,iterations:Infinity,easing:"ease-in-out"}
      );
    }catch{}
  }

  host.style.setProperty("left",x+"px","important");
  host.style.setProperty("top",y+"px","important");

  if(click){
    const ring=document.createElement("div");
    ring.setAttribute("aria-hidden","true");
    const rs=ring.style;
    rs.setProperty("position","fixed","important");
    rs.setProperty("left",x+"px","important");
    rs.setProperty("top",y+"px","important");
    rs.setProperty("width","8px","important");
    rs.setProperty("height","8px","important");
    rs.setProperty("border","2px solid #00eaff","important");
    rs.setProperty("border-radius","999px","important");
    rs.setProperty("pointer-events","none","important");
    rs.setProperty("z-index","2147483646","important");
    rs.setProperty("transform","translate(-50%,-50%)","important");
    rs.setProperty("opacity","1","important");
    (document.documentElement||document.body).appendChild(ring);
    try{
      ring.animate(
        [
          {transform:"translate(-50%,-50%) scale(.45)",opacity:1,borderColor:"#00eaff",boxShadow:"0 0 4px #00eaff"},
          {transform:"translate(-50%,-50%) scale(2.2)",opacity:.92,borderColor:"#7c5cff",boxShadow:"0 0 10px #7c5cff"},
          {transform:"translate(-50%,-50%) scale(3.8)",opacity:0,borderColor:"#ff3bd4",boxShadow:"0 0 18px #ff3bd4"}
        ],
        {duration:420,easing:"ease-out"}
      ).finished.finally(()=>ring.remove());
    }catch{ setTimeout(()=>ring.remove(),450); }

    const svg=host.querySelector("svg");
    try{ svg?.animate([{transform:"scale(.86) rotate(-5deg)"},{transform:"scale(1.08) rotate(3deg)"},{transform:"scale(1) rotate(0deg)"}],{duration:220,easing:"ease-out"}); }catch{}
  }
  return true;
}
function pointTarget(x,y,clickIt) {
  x=Number(x); y=Number(y);
  if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error("x/y must be numbers");
  visualCursor(x,y,!!clickIt);
  const el=document.elementFromPoint(x,y);
  if(!el) return {moved:true,clicked:false,x,y,visualCursor:true,targetFound:false};
  const init={bubbles:true,cancelable:true,clientX:x,clientY:y,view:window,button:0,pointerType:"mouse"};
  el.dispatchEvent(new PointerEvent("pointermove",init)); el.dispatchEvent(new MouseEvent("mousemove",init)); el.dispatchEvent(new MouseEvent("mouseover",init));
  if(clickIt){
    el.dispatchEvent(new PointerEvent("pointerdown",init)); el.dispatchEvent(new MouseEvent("mousedown",init));
    el.dispatchEvent(new PointerEvent("pointerup",init)); el.dispatchEvent(new MouseEvent("mouseup",init)); el.dispatchEvent(new MouseEvent("click",init));
    try{ el.click(); }catch{}
  }
  const r=el.getBoundingClientRect();
  return {moved:true,clicked:!!clickIt,x,y,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||el.getAttribute("aria-label")||"").trim().slice(0,160),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
}
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
function mouseAction(kind,x,y,button="left"){
  x=Number(x); y=Number(y); visualCursor(x,y,kind==="double"||kind==="right"||kind==="mousedown"||kind==="mouseup");
  const el=document.elementFromPoint(x,y); if(!el) return {ok:true,kind,x,y,visualCursor:true,targetFound:false};
  const btn=button==="right"?2:button==="middle"?1:0;
  const init={bubbles:true,cancelable:true,clientX:x,clientY:y,button:btn,view:window,pointerType:"mouse"};
  if(kind==="double"){ for(let i=0;i<2;i++){el.dispatchEvent(new PointerEvent("pointerdown",init));el.dispatchEvent(new MouseEvent("mousedown",init));el.dispatchEvent(new PointerEvent("pointerup",init));el.dispatchEvent(new MouseEvent("mouseup",init));el.dispatchEvent(new MouseEvent("click",{...init,detail:i+1}));} el.dispatchEvent(new MouseEvent("dblclick",{...init,detail:2})); }
  else if(kind==="right"){ el.dispatchEvent(new MouseEvent("contextmenu",{...init,button:2})); }
  else { if(kind.startsWith("mouse")) el.dispatchEvent(new MouseEvent(kind,init)); else el.dispatchEvent(new PointerEvent(kind,init)); }
  return {ok:true,kind,tag:el.tagName.toLowerCase(),x,y};
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
    case "bridge_info": { const t=await activeTab().catch(()=>null); return {extensionVersion:EXT_VERSION,connected:ws?.readyState===WebSocket.OPEN,activeTabId:t?.id||null,cdpAttached:[...cdpAttached],capabilities:["tabId","live_dom","dom_diff","deep_dom","shadow_dom","same_origin_iframes","element_map","viewport","wait_for","mouse_advanced","keyboard_combo","drag_drop","zoom","parallel_actions","cdp","screenshots","forms","click_fallback"]}; }
    case "get_page": { const t=await tab(); const result=await runInTab(t.id,pageSnapshot,[Math.min(Math.max(Number(args.maxChars||30000),1000),100000)]); return {tabId:t.id,...result}; }
    case "get_viewport": { const t=await tab(); return {tabId:t.id,...await runInTab(t.id,viewportInfo,[])}; }
    case "element_map": { const t=await tab(); return {tabId:t.id,elements:await runInTab(t.id,elementMap,[])}; }
    case "dom_watch": { const t=await tab(); const snap=await runInTab(t.id,domDigest,[Math.min(Math.max(Number(args.maxChars||40000),1000),100000)]); const prev=domState.get(t.id); domState.set(t.id,snap); return {tabId:t.id,changed:!prev||prev.url!==snap.url||prev.text!==snap.text,previousAt:prev?.at||null,current:snap}; }
    case "dom_diff": { const t=await tab(); const snap=await runInTab(t.id,domDigest,[Math.min(Math.max(Number(args.maxChars||40000),1000),100000)]); const prev=domState.get(t.id); domState.set(t.id,snap); if(!prev) return {tabId:t.id,baselineCreated:true,current:snap}; const oldSet=new Set(prev.interactive.map(x=>x.elementId+"|"+x.text)); const newSet=new Set(snap.interactive.map(x=>x.elementId+"|"+x.text)); return {tabId:t.id,urlChanged:prev.url!==snap.url,textChanged:prev.text!==snap.text,added:[...newSet].filter(x=>!oldSet.has(x)).slice(0,200),removed:[...oldSet].filter(x=>!newSet.has(x)).slice(0,200),at:snap.at}; }
    case "wait_for": { const t=await tab(); const timeout=Math.min(Math.max(Number(args.timeoutMs||10000),100),60000), interval=Math.min(Math.max(Number(args.intervalMs||250),50),2000), began=Date.now(); while(Date.now()-began<timeout){ if(await runInTab(t.id,findCondition,[args.selector||null,args.text||null])) return {found:true,tabId:t.id,elapsedMs:Date.now()-began}; await sleep(interval); } throw new Error("wait_for timed out"); }
    case "click": { const t=await tab(); return await runInTab(t.id,clickTarget,[args.selector||null,args.text||null]); }
    case "type": { const t=await tab(); return await runInTab(t.id,typeTarget,[args.selector,String(args.text??""),args.clearFirst!==false]); }
    case "navigate": { const t=await tab(); await chrome.tabs.update(t.id,{url:args.url}); return {navigated:true,tabId:t.id,url:args.url}; }
    case "move_mouse": { const t=await tab(); return await runInTab(t.id,pointTarget,[args.x,args.y,false]); }
    case "click_at": { const t=await tab(); return await runInTab(t.id,pointTarget,[args.x,args.y,true]); }
    case "mouse_action": { const t=await tab(); return await runInTab(t.id,mouseAction,[args.kind,args.x,args.y,args.button||"left"]); }
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
