import {guidedTour} from './guided-tour.js';
import {splitTabs} from './native-split.js';
import {CONTROL_MODES,DEFAULT_SHORTCUTS,validateShortcuts,assertControlMode} from './control-mode.js';
import {TargetManager,agentIndicator} from './target-manager.js';
import {siteSuggestions,safeUrls,contextPrompt,arrangeTargets} from './use-workspace.js';
let ws = null;
let reconnectTimer = null;
let pingTimer = null;
const EXT_VERSION = "0.12.4";
const domState = new Map();
const cdpAttached = new Set();
const networkState = new Map();
let commandQueue = Promise.resolve();
const targetManager = new TargetManager(chrome);
chrome.runtime.onStartup.addListener(()=>{void targetManager.invalidateSession();});
let reconnectAttempt = 0;
let captureActive = false;
let captureLastError = null;

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Stream a user-selected tab, window, or screen to the private GPT US viewer." });
}

async function toggleBrowserCapture(tab) {
  if (captureActive) {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: "capture_stop" });
    captureActive = false;
    chrome.action.setBadgeText({ text: ws?.readyState === WebSocket.OPEN ? "ON" : "OFF" });
    return;
  }
  const extensionTabs = await chrome.tabs.query({ url: chrome.runtime.getURL("*") });
  const captureHostTab = extensionTabs.find(item => item.url?.startsWith(chrome.runtime.getURL("")));
  if (!captureHostTab) throw new Error("Open the Comet ChatGPT Bridge options page once, then retry capture");
  const streamId = await new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab", "audio"], captureHostTab, id => id ? resolve(id) : reject(new Error("Capture selection cancelled")));
  });
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({ type: "capture_start", streamId });
  if (!result?.ok) throw new Error(result?.error || "Capture failed to start");
  captureLastError = null;
  captureActive = true;
  chrome.action.setBadgeText({ text: "LIVE" });
  chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== "capture_state") return;
  captureActive = !!message.active;
  chrome.action.setBadgeText({ text: captureActive ? "LIVE" : (ws?.readyState === WebSocket.OPEN ? "ON" : "OFF") });
  chrome.action.setBadgeBackgroundColor({ color: captureActive ? "#7c3aed" : (ws?.readyState === WebSocket.OPEN ? "#2e7d32" : "#9e9e9e") });
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.type==='use_chat_target'&&sender.id===chrome.runtime.id&&sender.url?.startsWith('https://chatgpt.com/')){chrome.storage.local.get('useChatTargets').then(v=>respond({targetId:v.useChatTargets?.[sender.tab?.id]||null}));return true;}
 if(message?.type==='use_workspace'&&sender.id===chrome.runtime.id&&(sender.url?.startsWith(chrome.runtime.getURL(''))||/^https:\/\/chatgpt\.com\//.test(sender.url||''))){
  const allowed=['use_state','use_prompt','use_disable','use_control_get','use_control_set'];
  if(sender.url?.startsWith(chrome.runtime.getURL('')))allowed.push('use_open','use_open_urls','use_arrange','use_capture','use_chat_right','use_split_selected','use_split_status');
  if(!allowed.includes(message.command))return;
  useWorkspace(message.command,message.args||{}).then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message}));return true;
 }
 if(message?.type!=='target_workspace'||sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('')))return;
 if(!['browser_targets_list','browser_targets_clear','browser_target_add','browser_target_add_by_url','browser_target_remove','browser_target_focus'].includes(message.command))return;
 executeCommand(message.command,message.args||{}).then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message}));return true;
});
async function controlPreferences(){const value=(await chrome.storage.local.get('controlPreferences')).controlPreferences;return {mode:CONTROL_MODES.includes(value?.mode)?value.mode:'auto',shortcuts:value?.shortcuts||DEFAULT_SHORTCUTS,connected:ws?.readyState===WebSocket.OPEN};}
async function setControlPreferences(args){const previous=await controlPreferences();if(args.mode!==undefined&&!CONTROL_MODES.includes(args.mode))throw Error('Invalid control mode');const next={mode:args.mode??previous.mode,shortcuts:args.shortcuts===undefined?previous.shortcuts:validateShortcuts(args.shortcuts)};await chrome.storage.local.set({controlPreferences:next});if(next.mode==='programmatic'){const tabs=await chrome.tabs.query({});await Promise.allSettled(tabs.filter(t=>/^https?:/.test(t.url||'')).map(t=>chrome.scripting.executeScript({target:{tabId:t.id},func:()=>{for(const id of ['__cgb_cursor_host','__gptus_blue_agent','__gptus_activity_wave'])document.getElementById(id)?.style.setProperty('display','none','important');}})));}if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'control_mode',mode:next.mode}));return {...next,connected:ws?.readyState===WebSocket.OPEN};}
async function useWorkspace(command,args={}){
 if(command==='use_split_status')return {supported:typeof chrome.tabs.createSplit==='function',tabs:(await chrome.tabs.query({highlighted:true,currentWindow:true})).map(t=>({tabId:t.id,title:t.title,url:t.url,splitViewId:t.splitViewId}))};
 if(command==='use_split_selected'){const tabs=await chrome.tabs.query({highlighted:true,currentWindow:true});return splitTabs(chrome,tabs);}
 if(command==='use_chat_right'){
  const source=await activeTab();if(!/^https?:/.test(source.url||'')||source.url?.startsWith('https://chatgpt.com/'))throw Error('افتح الموقع المطلوب أولًا ثم اضغط الإضافة');
  const target=await targetManager.add({tabId:source.id});await chrome.storage.local.set({useEnabled:true});
  const chat=await chrome.tabs.create({url:'https://chatgpt.com/#gpt-us-use',windowId:source.windowId,index:source.index+1,active:true});
  const links=(await chrome.storage.local.get('useChatTargets')).useChatTargets||{};links[chat.id]=target.targetId;await chrome.storage.local.set({useChatTargets:links});await injectUse(chat.id,chat.url);
  if(typeof chrome.tabs.createSplit!=='function')return {opened:true,chatTabId:chat.id,targetId:target.targetId,verified:false,reason:'NATIVE_SPLIT_API_UNAVAILABLE',message:'الشات مربوط بالموقع؛ من قائمة تبويب ChatGPT اختر فتح في العرض المنقسم ثم الموقع. لم تُفتح نافذة أخرى.'};
  const actual=await chrome.tabs.get(source.id);if(actual.groupId>=0)await chrome.tabs.group({tabIds:[chat.id],groupId:actual.groupId});if(actual.pinned)await chrome.tabs.update(chat.id,{pinned:true});
  return {...await splitTabs(chrome,[await chrome.tabs.get(source.id),await chrome.tabs.get(chat.id)]),chatTabId:chat.id,targetId:target.targetId};
 }
 if(command==='use_control_get')return controlPreferences();
 if(command==='use_control_set')return setControlPreferences(args);
 if(command==='use_state'){const targets=await targetManager.list();const links=(await chrome.storage.local.get('useChatTargets')).useChatTargets||{};return {chatTargets:links,targets,suggestions:targets.filter(t=>t.status==='CONNECTED').map(t=>({targetId:t.targetId,title:t.title,items:siteSuggestions(t.url)}))};}
 if(command==='use_disable'){await chrome.storage.local.set({useEnabled:false});return {disabled:true};}
 if(command==='use_open'){
  await chrome.storage.local.set({useEnabled:true});const tab=await chrome.tabs.create({url:'https://chatgpt.com/#gpt-us-use',active:true});return {opened:true,tabId:tab.id};
 }
 if(command==='use_capture'){await toggleBrowserCapture(await activeTab());return {active:captureActive};}
 if(command==='use_open_urls'){
  const urls=safeUrls(args.urls),results=[];for(const url of urls){const tab=await chrome.tabs.create({url,active:false});results.push({tabId:tab.id,url});}return {opened:results};
 }
 const ids=args.targetIds;if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)throw Error('اختر من هدف واحد إلى 8 أهداف مختلفة');
 const targets=await Promise.all(ids.map(id=>targetManager.get(id)));
 if(command==='use_prompt')return {prompt:contextPrompt(targets,String(args.question||'افحص التبويبات المختارة معًا واقترح خطوات عملية.').slice(0,2000))};
 if(command==='use_arrange'){const tabs=await Promise.all(ids.map(id=>targetManager.resolve(id)));return args.mode==='side_by_side'?splitTabs(chrome,tabs):arrangeTargets(chrome,tabs,args.mode);}
 throw Error('Unknown Use command');
}
async function injectUse(tabId,url){if(!/^https:\/\/chatgpt\.com\//.test(url||''))return;const {useEnabled}=await chrome.storage.local.get('useEnabled');if(useEnabled)await chrome.scripting.executeScript({target:{tabId},files:['use-skin.js','use-controls.js']}).catch(()=>{});}
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{if(change.status==='complete')void injectUse(tabId,tab.url);});

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
    void controlPreferences().then(p=>ws?.readyState===WebSocket.OPEN&&ws.send(JSON.stringify({type:"control_mode",mode:p.mode})));
    reconnectAttempt = 0;
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  };

  const connection = ws;
  ws.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if(msg.type==='activity_effects'&&typeof msg.enabled==='boolean'){
      void chrome.storage.local.set({desktopActivityEffectsEnabled:msg.enabled}).then(async()=>{
        const tabs=await chrome.tabs.query({});
        await Promise.allSettled(tabs.filter(tab=>tab.id&&/^https?:/.test(tab.url||'')).map(tab=>chrome.scripting.executeScript({target:{tabId:tab.id},files:['activity-wave.js']})));
      });return;
    }
    if (msg.type !== "command" || !msg.id) return;
    commandQueue = commandQueue.catch(()=>{}).then(async()=>{
      if(connection.readyState!==WebSocket.OPEN)return;
      let reply;
      try { reply={type:"result",id:msg.id,ok:true,result:await executeCommand(msg.command,msg.args||{})}; }
      catch(error){reply={type:"result",id:msg.id,ok:false,error:String(error?.message||error)};}
      if(connection.readyState===WebSocket.OPEN)connection.send(JSON.stringify(reply));
    });
  };
  ws.onclose = () => { if(ws===connection){ws = null; scheduleReconnect();} };
  ws.onerror = () => { try { connection.close(); } catch {} };
}

function scheduleReconnect() {
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(()=>connect().catch(scheduleReconnect), Math.min(10000,1000*2**reconnectAttempt++)+Math.floor(Math.random()*250));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}
async function pinnedTab(){
 const {workingTarget}=await chrome.storage.local.get("workingTarget");
 if(!workingTarget)return null;
 const {targetSession}=await chrome.storage.session.get("targetSession");
 if(workingTarget.session!==targetSession)throw new Error("Browser session changed; select target again");
 const tab=await chrome.tabs.get(workingTarget.tabId).catch(()=>null);
 if(!tab||tab.windowId!==workingTarget.windowId)throw new Error("Pinned tab closed; select a new target");
 return tab;
}
async function chooseWorkingTab(args){
 const tabs=await chrome.tabs.query({currentWindow:true});
 let candidates=tabs.filter(t=>args.tabId!==undefined?t.id===Number(args.tabId):args.titleContains?(t.title||"").includes(args.titleContains):args.urlContains?(t.url||"").includes(args.urlContains):true);
 if(args.side){const active=tabs.find(t=>t.active);const visible=tabs.filter(t=>t.splitViewId===active?.splitViewId&&Number.isInteger(t.splitViewId)&&t.splitViewId>=0).sort((a,b)=>a.index-b.index);if(visible.length!==2)throw new Error("Split side is ambiguous; choose tabId");candidates=[args.side==="left"?visible[0]:visible[1]];}
 if(candidates.length!==1)throw new Error("Target must identify exactly one tab");
 const tab=candidates[0];let {targetSession}=await chrome.storage.session.get("targetSession");
 if(!targetSession){targetSession=crypto.randomUUID();await chrome.storage.session.set({targetSession});}
 await chrome.storage.local.set({workingTarget:{tabId:tab.id,windowId:tab.windowId,session:targetSession,url:tab.url,element:args.element||null}});
 return {selected:true,tab:{id:tab.id,windowId:tab.windowId,title:tab.title,url:tab.url},session:targetSession};
}
async function targetTab(args={}) {
 if(args.targetId)return targetManager.resolve(args.targetId);
 const pinned=await pinnedTab();
 if(args.tabId!==undefined){if(pinned&&pinned.id!==Number(args.tabId))throw new Error("Explicit tab differs from pinned target; select it first");return await chrome.tabs.get(Number(args.tabId));}
 if(pinned)return pinned;
 return activeTab();
}
function layeredDOM(args){
 const matches=args.selector?[...document.querySelectorAll(args.selector)]:args.name?[...document.querySelectorAll("button,a,input,textarea,[role=button]")].filter(e=>(e.getAttribute("aria-label")||e.innerText||"").trim()===args.name):[];
 const element=matches.length===1?matches[0]:null;
 const rect=element?.getBoundingClientRect();
 const secret=element?.type==="password";
 const state={url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,20000),element:element?{exists:true,name:element.getAttribute("aria-label")||element.innerText||"",value:secret?"[REDACTED]":element.value,disabled:!!element.disabled,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}:null,scrollY};
 if(args.observe)return state;
 if(matches.length>1||element?.disabled)return {notExecuted:true,retrySafe:false,reason:"Target ambiguous or disabled; reselect explicitly"};
 if(!element||!rect.width||!rect.height)return {notExecuted:true,retrySafe:true,reason:"Element missing or hidden"};
 if(secret)return {notExecuted:true,retrySafe:false,reason:"Protected field cannot be verified"};
 if(args.action==='select'&&element.tagName==='SELECT'){
   if(![...element.options].some(option=>option.value===String(args.text)))return {notExecuted:true,retrySafe:false,reason:'Option value unavailable'};
   element.value=String(args.text);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return {executed:true};
 }
 if(args.action==="click"){element.click();return {executed:true};}
 if(args.action==="type"){
  const prototype=element.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  const setter=Object.getOwnPropertyDescriptor(prototype,"value")?.set;
  if(!setter||element.readOnly)return {notExecuted:true,retrySafe:true,reason:"Element does not support value"};
  setter.call(element,String(args.text||""));element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return {executed:true};
 }
 return {notExecuted:true,retrySafe:true,reason:"Unsupported DOM operation"};
}
async function browserLayerAct(tabId,args){
 if(args.layer==="dom"){if(args.action==="click"&&typeof showNativeCursor==="function"){const observation=await runInTab(tabId,layeredDOM,[{...args,observe:true}]);const b=observation.element?.bounds;if(b&&!observation.element.disabled)await showNativeCursor(tabId,b.x+b.width/2,b.y+b.height/2,true).catch(()=>{});}return await runInTab(tabId,layeredDOM,[args]);}
 if(!["cdp","accessibility"].includes(args.layer))return {notExecuted:true,retrySafe:true,reason:"Unsupported browser layer"};
 let box;
 try{
  if(args.layer==="accessibility"){
   const {nodes}=await cdp(tabId,"Accessibility.getFullAXTree");
   const interactiveRoles=['button','link','menuitem','checkbox','radio','tab','textbox','combobox','switch','treeitem','option'];
   const matches=nodes.filter(n=>!n.ignored&&interactiveRoles.includes(n.role?.value)&&n.name?.value===args.name&&n.backendDOMNodeId);
   if(matches.length!==1)return {notExecuted:true,retrySafe:true,reason:"AX target missing or ambiguous"};
   if(matches[0].properties?.some(p=>p.name==='disabled'&&p.value?.value===true))return {notExecuted:true,retrySafe:false,reason:'AX target disabled'};
   const result=await cdp(tabId,"DOM.getBoxModel",{backendNodeId:matches[0].backendDOMNodeId});box=result.model.content;
  }else{
   const state=await runInTab(tabId,layeredDOM,[{...args,observe:true}]);
   if(!state.element)return {notExecuted:true,retrySafe:true,reason:"CDP target unavailable"};
   if(state.element.disabled)return {notExecuted:true,retrySafe:false,reason:'CDP target disabled'};
   const b=state.element.bounds;box=[b.x,b.y,b.x+b.width,b.y,b.x+b.width,b.y+b.height,b.x,b.y+b.height];
  }
 }catch(error){return {notExecuted:true,retrySafe:true,reason:error.message};}
 if(args.action!=="click")return {notExecuted:true,retrySafe:true,reason:"This CDP/AX adapter supports click only"};
 const x=(box[0]+box[4])/2,y=(box[1]+box[5])/2;
 // DOM mutation can work in a background tab; native CDP input needs its
 // renderer visible. Activate only the pinned tab, never the current tab.
 try{const target=await chrome.tabs.update(tabId,{active:true});if(chrome.windows?.update)await chrome.windows.update(target.windowId,{focused:true});}
 catch(error){return {notExecuted:true,retrySafe:false,reason:'Cannot activate pinned input target: '+error.message};}
 if(typeof showNativeCursor==="function")await showNativeCursor(tabId,x,y,true).catch(()=>{});
 await cdp(tabId,"Input.dispatchMouseEvent",{type:"mouseMoved",x,y,button:"none"});
 await cdp(tabId,"Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
 try{await cdp(tabId,"Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1});}catch(error){throw new Error("Click outcome unknown: "+error.message);}
 return {executed:true};
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
  globalThis.__gptusShowWave?.();
  // Isolated-world state is reset by document navigation; reuse helpers within it.
  if(globalThis.__gptusHelpersVersion==="0.9.3")return;
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
  globalThis.__gptusHelpersVersion="0.9.3";
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
async function clickTarget(selector,text,cfg={}) {
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
  const r=clickable.getBoundingClientRect();
  const x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2));
  const y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));
  let visualCursorShown=false;
  if(cfg.enabled!==false) visualCursorShown=await globalThis.visualCursor(x,y,cfg.clickEffect!==false,cfg);
  clickable.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerType:"mouse"}));
  clickable.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,view:window}));
  clickable.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,view:window}));
  clickable.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerType:"mouse"}));
  clickable.click();
  return {clicked:true,tag:el.tagName.toLowerCase(),text:(el.innerText||el.value||"").trim().slice(0,200),x,y,input:"DOM",visualCursorShown};
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

const nativeButtons = new Map();
async function getCursorVisualConfig(){
  const cfg=await chrome.storage.local.get(["cursorSize","cursorSpeed","cursorColor","clickColor","cursorEnabled","clickEffect","controlPreferences"]);
  return {enabled:cfg.cursorEnabled!==false&&cfg.controlPreferences?.mode!=="programmatic",clickEffect:cfg.clickEffect!==false&&cfg.controlPreferences?.mode!=="programmatic",size:Number(cfg.cursorSize||30),speed:Number(cfg.cursorSpeed||180),color:cfg.cursorColor||"#27e9f5",clickColor:cfg.clickColor||"#27e9f5"};
}
async function showNativeCursor(tabId,x,y,click){
  const cfg=await getCursorVisualConfig();
  if(!cfg.enabled)return false;
  try{return !!await runInTab(tabId,visualCursor,[x,y,!!click&&cfg.clickEffect!==false,cfg]);}
  catch{return false;}
}
async function nativeMouseAction(tabId,args) {
  const x=Number(args.x), y=Number(args.y), kind=args.kind;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0) throw new Error("Invalid viewport coordinates");
  if(!["click","double","right","mousedown","mouseup","mousemove","mouseover"].includes(kind)) throw new Error("Invalid mouse action");
  await ensureCdp(tabId);
  const button=kind==="right"?"right":args.button||"left";
  if(!["left","right","middle"].includes(button)) throw new Error("Invalid button");
  const mask=button==="right"?2:button==="middle"?4:1;
  const send=(type,b,buttons,count=0)=>chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type,x,y,button:b,buttons,clickCount:count});
  let held=nativeButtons.get(tabId)||0;
  const visualCursorShown=await showNativeCursor(tabId,x,y,["click","double","right","mousedown","mouseup"].includes(kind));
  await send("mouseMoved","none",held);
  if(kind==="mousedown"){await send("mousePressed",button,held|mask,1);nativeButtons.set(tabId,held|mask);}
  else if(kind==="mouseup"){await send("mouseReleased",button,held&~mask,1);nativeButtons.set(tabId,held&~mask);}
  else if(kind==="click"||kind==="double"||kind==="right"){
    for(let count=1;count<=(kind==="double"?2:1);count++){
      try{await send("mousePressed",button,held|mask,count);}
      finally{await send("mouseReleased",button,held,count);}
    }
  }
  return {dispatched:true,input:"CDP",kind,x,y,buttons:nativeButtons.get(tabId)||held,visualCursorShown,uiVerified:false,physicalCursor:false};
}

async function nativeMousePath(tabId, points, options={}) {
  if(!Array.isArray(points)||points.length<2||points.length>3000)throw new Error("native_mouse_path requires 2–3000 points");
  const pts=points.map(p=>({x:Number(p.x),y:Number(p.y)}));
  if(pts.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0))throw new Error("Invalid path coordinates");
  await ensureCdp(tabId);
  const duration=Math.max(40,Math.min(15000,Number(options.durationMs||700)));
  const press=options.press!==false;
  const release=options.release!==false;
  const button=String(options.button||"left");
  if(!["left","middle","right"].includes(button))throw new Error("Invalid mouse button");
  const buttons=button==="right"?2:button==="middle"?4:1;
  const start=pts[0];
  await chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type:"mouseMoved",x:start.x,y:start.y,button:"none",buttons:0});
  let last=start,finished=false;
  try{
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
      last={x,y};
      await sleep(Math.max(1,Math.round(duration*(seg/total)/steps)));
    }
  }
  finished=true;
  }finally{
    if(press&&(release||!finished))await chrome.debugger.sendCommand({tabId},"Input.dispatchMouseEvent",{type:"mouseReleased",x:last.x,y:last.y,button,buttons:0,clickCount:1});
    nativeButtons.set(tabId,press&&!release&&finished?buttons:0);
  }
  const end=pts[pts.length-1];
  await showNativeCursor(tabId,end.x,end.y,false).catch(()=>{});
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

const feedbackCommands=new Set(['get_page','get_viewport','element_map','dom_watch','dom_diff','wait_for','layer_observe','accessibility_tree','click','type','layer_act','mouse_move','mouse_click','mouse_action','mouse_path','drag_drop','scroll','hover','select','press_key','key_combo','navigate','zoom','reload']);
async function executeCommand(command,args={}){
 if(!feedbackCommands.has(command))return executeCommandCore(command,args);
 const settings=await chrome.storage.local.get(['blueAgentEffectsEnabled','controlPreferences']);
 if(settings.blueAgentEffectsEnabled===false||settings.controlPreferences?.mode==='programmatic'||settings.controlPreferences?.mode==='desktop')return executeCommandCore(command,args);
 assertControlMode(settings.controlPreferences?.mode||'auto','browser',command,args);
 const tab=await targetTab(args);const read=['get_page','get_viewport','element_map','dom_watch','dom_diff','wait_for','layer_observe','accessibility_tree'].includes(command);
 const indicate=state=>chrome.scripting.executeScript({target:{tabId:tab.id},func:agentIndicator,args:[state]}).catch(()=>{});
 await indicate(read?'OBSERVING':'ACTING');
 try{const result=await executeCommandCore(command,args);await indicate(result?.notExecuted||result?.ok===false?'ERROR':result?.verified===true?'SUCCESS':read?'OBSERVING':'WAITING');return result;}
 catch(error){await indicate('ERROR');throw error;}
}
function tourSnapshot(){return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,14000),headings:[...document.querySelectorAll('h1,h2,h3')].map(n=>n.textContent.trim()).slice(0,30),links:[...document.querySelectorAll('nav a[href],header a[href],main a[href]')].map(a=>({url:a.href,text:a.innerText.trim()})).slice(0,120),scrollY};}
async function executeCommandCore(command,args={}){
 if(command==='browser_guided_tour'){
  assertControlMode((await controlPreferences()).mode,'browser','scroll',{});
  const tab=await targetManager.resolve(args.targetId);const observe=async()=>{const current=await chrome.tabs.get(tab.id);if(current.status==='loading'){for(let i=0;i<40;i++){await sleep(200);if((await chrome.tabs.get(tab.id)).status==='complete')break;}}return runInTab(tab.id,tourSnapshot);};
  return guidedTour({maxPages:args.maxPages??3,observe,navigate:async url=>{await chrome.tabs.update(tab.id,{url});await sleep(200);},scroll:()=>executeCommand('scroll',{targetId:args.targetId,y:Math.round(700),behavior:'instant'}),save:state=>chrome.storage.local.set({guidedTourState:{...state,targetId:args.targetId}})});
 }
 if(command==='browser_guided_tour_status')return (await chrome.storage.local.get('guidedTourState')).guidedTourState||{status:'none'};
  if(command==="browser_split_capabilities")return {createSplit:typeof chrome.tabs.createSplit==="function",unsplit:typeof chrome.tabs.unsplit==="function",splitMethods:Object.keys(chrome.tabs).filter(k=>/split/i.test(k)),userAgent:navigator.userAgent};
  if(command==="browser_control_mode_get")return controlPreferences();
  if(command==="browser_control_mode_set")return setControlPreferences(args);
  assertControlMode((await controlPreferences()).mode,"browser",command,args);
  if(command==='browser_chat_right')return useWorkspace('use_chat_right');
  if(command==='browser_split_selected')return useWorkspace('use_split_selected');
  if(command==='browser_use_open')return useWorkspace('use_open');
  if(command==='browser_workspace_open_urls')return useWorkspace('use_open_urls',args);
  if(command==='browser_workspace_context')return useWorkspace('use_prompt',args);
  if(command==='browser_workspace_arrange')return useWorkspace('use_arrange',args);
  if(command==='browser_workspace_suggestions')return useWorkspace('use_state',{});
  if(command.startsWith('browser_target')){
   if(command==='browser_targets_list')return targetManager.list();
   if(command==='browser_targets_clear')return targetManager.clear();
   if(command==='browser_target_add')return targetManager.add(args);
   if(command==='browser_target_add_by_url')return targetManager.add({url:args.url,role:args.role});
   if(command==='browser_target_add_current'){const current=await activeTab();return targetManager.add({...args,tabId:current.id});}
   if(command==='browser_target_get'||command==='browser_target_status')return targetManager.get(args.targetId);
   if(command==='browser_target_remove')return targetManager.remove(args.targetId);
   if(command==='browser_target_focus')return targetManager.focus(args.targetId);
   if(command==='browser_target_command'){
    const allowed=['get_page','get_viewport','element_map','dom_watch','dom_diff','accessibility_tree','layer_observe','layer_act','scroll','click','type','select','navigate','zoom'];
    if(!allowed.includes(args.command))throw Error('Target command not allowed');
    const tab=await targetManager.resolve(args.targetId);
    const indicate=async()=>{};
    await indicate(['get_page','get_viewport','element_map','dom_watch','dom_diff','accessibility_tree','layer_observe'].includes(args.command)?'OBSERVING':'ACTING');
    try{const result=await executeCommand(args.command,{...(args.args||{}),targetId:args.targetId,tabId:tab.id});await indicate(['get_page','get_viewport','element_map','dom_watch','dom_diff','accessibility_tree','layer_observe'].includes(args.command)?'SUCCESS':'WAITING');return {targetId:args.targetId,tabId:tab.id,executed:true,verified:false,result};}
    catch(error){await indicate('ERROR');throw error;}
   }
   throw Error('Unknown target command');
  }
  const tab=async()=>await targetTab(args);
  switch(command){
    case "select_working_tab":return await chooseWorkingTab(args);
    case "get_working_tab":{const t=await pinnedTab();const {workingTarget}=await chrome.storage.local.get('workingTarget');return t?{selected:true,tab:{id:t.id,windowId:t.windowId,url:t.url,title:t.title},element:workingTarget?.element||null}:{selected:false};}
    case "clear_working_tab":await chrome.storage.local.remove("workingTarget");return {cleared:true};
    case "layer_observe":{const t=await tab();return {tabId:t.id,...await runInTab(t.id,layeredDOM,[{...args,observe:true}])};}
    case "layer_act":{const t=await tab();return await browserLayerAct(t.id,args);}
    case "accessibility_tree":{const t=await tab();const {nodes}=await cdp(t.id,"Accessibility.getFullAXTree");return {tabId:t.id,nodes:nodes.slice(0,1000).map(n=>({nodeId:n.nodeId,role:n.role?.value,name:n.name?.value,ignored:n.ignored,childIds:n.childIds,backendDOMNodeId:n.backendDOMNodeId}))};}
    case "workspace_report": {
      const t=await tab();
      const report={schemaVersion:1,observedAt:new Date().toISOString(),coordinateSpace:"css-viewport",tabId:t.id,
        page:await runInTab(t.id,pageSnapshot,[10000]),elements:await runInTab(t.id,elementMap,[]),staleAfterNavigation:true};
      await chrome.storage.local.set({workspaceReport:report});
      return report;
    }
    case "smart_actions_save": {
      const options=Array.isArray(args.options)?args.options:[];
      if(options.length>9||options.some(item=>!Number.isInteger(item.number)||item.number<0||item.number>9||typeof item.label!=="string"||item.label.length>100||typeof item.prompt!=="string"||item.prompt.length>320))throw new Error("Invalid smart actions");
      const previous=(await chrome.storage.local.get("smartActions")).smartActions||{};
      const smartActions={schemaVersion:1,observedAt:new Date().toISOString(),options:options.map(item=>({number:item.number,label:item.label,prompt:item.prompt,source:item.source||"browser"})),usage:previous.usage||{}};
      await chrome.storage.local.set({smartActions});
      return {saved:true,count:smartActions.options.length};
    }
    case "smart_actions_read": return {found:true,state:(await chrome.storage.local.get("smartActions")).smartActions||null};
    case "smart_actions_choose": {
      const stored=(await chrome.storage.local.get("smartActions")).smartActions;
      const number=Number(args.number);const option=stored?.options?.find(item=>item.number===number);
      if(!option)throw new Error("Numbered option unavailable");
      const key=option.label.toLocaleLowerCase();stored.usage[key]=Math.min(10000,(stored.usage[key]||0)+1);
      await chrome.storage.local.set({smartActions:stored});
      return {selected:true,number,label:option.label,prompt:option.prompt};
    }
    case "bridge_info": { const t=await activeTab().catch(()=>null);const working=await pinnedTab().catch(()=>null); return {workingTabId:working?.id||null,extensionVersion:EXT_VERSION,sourceBuild:"use-workspace",connected:ws?.readyState===WebSocket.OPEN,captureActive,activeTabId:t?.id||null,cdpAttached:[...cdpAttached],capabilities:["multi-target","target-workspace","tabId","live_dom","dom_diff","deep_dom","shadow_dom","same_origin_iframes","element_map","viewport","wait_for","mouse_advanced","smooth_cursor","freehand_draw","native_mouse_path","keyboard_combo","drag_drop","zoom","parallel_actions","cdp","screenshots","browser_live_capture","system_audio","forms","click_fallback"]}; }
    case "browser_capture_status": return { active:captureActive, lastError:captureLastError, requiresUserGesture:!captureActive, startHint:"Click the Comet ChatGPT Bridge toolbar icon and choose a tab, window, or screen." };
    case "browser_capture_stop": await ensureOffscreenDocument(); await chrome.runtime.sendMessage({type:"capture_stop"}); captureActive=false; return {stopped:true};
    case "get_page": { const t=await tab(); const result=await runInTab(t.id,pageSnapshot,[Math.min(Math.max(Number(args.maxChars||30000),1000),100000)]); return {tabId:t.id,...result}; }
    case "get_viewport": { const t=await tab(); return {tabId:t.id,...await runInTab(t.id,viewportInfo,[])}; }
    case "element_map": { const t=await tab(); return {tabId:t.id,elements:await runInTab(t.id,elementMap,[])}; }
    case "dom_watch": { const t=await tab(); const snap=await runInTab(t.id,domDigest,[Math.min(Math.max(Number(args.maxChars||40000),1000),100000)]); const prev=domState.get(t.id); domState.set(t.id,snap); return {tabId:t.id,changed:!prev||prev.url!==snap.url||prev.text!==snap.text,previousAt:prev?.at||null,current:snap}; }
    case "dom_diff": { const t=await tab(); const snap=await runInTab(t.id,domDigest,[Math.min(Math.max(Number(args.maxChars||40000),1000),100000)]); const prev=domState.get(t.id); domState.set(t.id,snap); if(!prev) return {tabId:t.id,baselineCreated:true,current:snap}; const oldSet=new Set(prev.interactive.map(x=>x.elementId+"|"+x.text)); const newSet=new Set(snap.interactive.map(x=>x.elementId+"|"+x.text)); return {tabId:t.id,urlChanged:prev.url!==snap.url,textChanged:prev.text!==snap.text,added:[...newSet].filter(x=>!oldSet.has(x)).slice(0,200),removed:[...oldSet].filter(x=>!newSet.has(x)).slice(0,200),at:snap.at}; }
    case "wait_for": { const t=await tab(); const timeout=Math.min(Math.max(Number(args.timeoutMs||10000),100),60000), interval=Math.min(Math.max(Number(args.intervalMs||250),50),2000), began=Date.now(); while(Date.now()-began<timeout){ if(await runInTab(t.id,findCondition,[args.selector||null,args.text||null])) return {found:true,tabId:t.id,elapsedMs:Date.now()-began}; await sleep(interval); } throw new Error("wait_for timed out"); }
    case "click": { const t=await tab(); return await runInTab(t.id,clickTarget,[args.selector||null,args.text||null,await getCursorVisualConfig()]); }
    case "type": { const t=await tab(); return await runInTab(t.id,typeTarget,[args.selector,String(args.text??""),args.clearFirst!==false]); }
    case "navigate": { const t=await tab(); await chrome.tabs.update(t.id,{url:args.url}); return {navigated:true,tabId:t.id,url:args.url}; }
    case "move_mouse": { const t=await tab(); return await nativeMouseAction(t.id,{...args,kind:"mousemove"}); }
    case "click_at": { const t=await tab(); return await nativeMouseAction(t.id,{...args,kind:"click"}); }
    case "mouse_action": { const t=await tab(); return await nativeMouseAction(t.id,args); }
    case "draw_path": { const t=await tab(); return await runInTab(t.id,drawPath,[args.points||[],args.options||{}]); }
    case "native_mouse_path": { const t=await tab(); return await nativeMousePath(t.id,args.points||[],args.options||{}); }
    case "clear_drawings": { const t=await tab(); return await runInTab(t.id,clearDrawings,[]); }
    case "drag_drop": { const t=await tab(); return await nativeMousePath(t.id,[{x:args.fromX,y:args.fromY},{x:args.toX,y:args.toY}],{press:true,release:true,durationMs:args.durationMs??300,button:args.button??"left"}); }
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
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage().catch(error=>{
  captureLastError = String(error?.message || error);
  chrome.action.setBadgeText({text:"ERR"}); chrome.action.setBadgeBackgroundColor({color:"#c62828"});
  console.error("GPT US capture:",error);
}));
connect();

chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.blueAgentEffectsEnabled?.newValue===false){void targetManager.list().then(targets=>Promise.all(targets.filter(t=>t.status==='CONNECTED').map(t=>chrome.scripting.executeScript({target:{tabId:t.chromeTabId},func:agentIndicator,args:['IDLE']}).catch(()=>{}))));}});
void chrome.tabs.query({url:'https://chatgpt.com/*'}).then(tabs=>Promise.all(tabs.map(t=>injectUse(t.id,t.url))));
