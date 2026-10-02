import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('keyboard and settings preserve live height and keep chat inline',()=>{
 const h=harness({connected:true,streamUrl:'wss://bridge/live?ticket=test',monitors:[{index:0,primary:true}]});
 const height=h.document.body.style['--live-height'];assert.equal(height,'294px');
 h.elements.settingsToggle.listeners.click();h.elements.keyboardToggle.listeners.click();
 assert.equal(h.document.body.style['--live-height'],height);assert.equal(h.elements.remoteText.focusOptions.preventScroll,true);
 assert.equal(h.displayModes[0],'inline');
 const html=readFileSync(new URL('./live-view.html',import.meta.url),'utf8');assert.match(html,/font: 16px system-ui/);assert.match(html,/\.screen, body.expanded \.screen \{ height: var\(--live-height,340px\); min-height: 0; \}/);
});

test('touchpad and mobile keyboard use the private stream and preserve failed text',()=>{
 const h=harness({connected:true,streamUrl:'wss://bridge/live?ticket=test',monitors:[{index:0,primary:true}]});
 const socket=h.sockets[0];socket.onopen();
 h.elements.keyboardToggle.listeners.click();assert.equal(h.elements.remoteText.focused,true);
 assert.equal(h.elements.remoteText.focusOptions.preventScroll,true);
 h.elements.settingsToggle.listeners.click();assert.equal(h.elements.controlSettings.hidden,false);
 h.elements.remoteText.value='مرحبا';h.elements.sendText.listeners.click();
 const typed=socket.sent.at(-1);assert.equal(typed.command,'text');assert.equal(typed.args.text,'مرحبا');
 socket.onmessage({data:JSON.stringify({type:'control_result',id:typed.id,ok:false,error:'Permission disabled'})});assert.equal(h.elements.remoteText.value,'مرحبا');
 h.elements.sendText.listeners.click();const retry=socket.sent.at(-1);
 socket.onmessage({data:JSON.stringify({type:'control_result',id:retry.id,ok:true})});assert.equal(h.elements.remoteText.value,'');
 const e=(x,y)=>({pointerId:1,clientX:x,clientY:y,preventDefault(){}});
 h.elements.touchpad.listeners.pointerdown(e(10,10));h.elements.touchpad.listeners.pointermove(e(30,40));h.elements.touchpad.listeners.pointerup(e(30,40));
 assert.equal(socket.sent.at(-1).command,'pad');assert.equal(socket.sent.at(-1).args.dx,30);assert.equal(socket.sent.at(-1).args.dy,45);
 h.elements.rightClick.listeners.click();assert.equal(socket.sent.at(-1).args.button,'right');
 h.document.hidden=true;const count=socket.sent.length;h.elements.enterKey.listeners.click();assert.equal(socket.sent.length,count);
});

function harness(initial=null, toolResult=null) {
  const html=readFileSync(new URL('./live-view.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1]?.replace('__GPT_US_BOOTSTRAP_STATE__',JSON.stringify(initial));
  const calls=[]; const sockets=[]; const timers=new Map(); let timerId=0;
const node=()=>({hidden:true,setAttribute(){},focus(options){this.focused=true;this.focusOptions=options},setPointerCapture(){},textContent:'',value:'',src:'',options:[],listeners:{},style:{setProperty(name,value){this[name]=value}},classList:{ready:false,add(){this.ready=true},remove(){this.ready=false}},replaceChildren(...items){this.options=items},addEventListener(type,fn){this.listeners[type]=fn},removeAttribute(){},requestFullscreen(){},play(){return Promise.resolve()},pause(){},load(){}});
  const elements=Object.fromEntries(['screen','frame','video','message','status','monitor','toggle','audio','expand','settingsToggle','controlSettings','controlStatus','touchpad','padToggle','keyboardToggle','padPanel','keyboardPanel','remoteText','sendText','leftClick','rightClick','doubleClick','enterKey','backspaceKey','tabKey','escapeKey'].map(id=>[id,node()]));
  class FakeWebSocket { static OPEN=1; constructor(url){this.url=url;this.readyState=1;this.sent=[];sockets.push(this)} send(value){this.sent.push(JSON.parse(value))} close(){this.readyState=3} }
  const openTargets=[]; const displayModes=[];
  const windowEvents={}; const documentEvents={}; const intervals=new Map();
  const window={parent:{postMessage(){}},addEventListener(type,fn){windowEvents[type]=fn},openai:{displayMode:'inline',async callTool(name,args){calls.push({name,args});return {structuredContent:toolResult};},async requestDisplayMode({mode}){displayModes.push(mode);this.displayMode=mode;return {mode}},setOpenInAppUrl(target){openTargets.push(target)}}};
  class FakeFileReader { readAsDataURL(){this.result='data:image/webp;base64,QUJD';this.onload?.()} }
const context={window,WebSocket:FakeWebSocket,Blob:class{},FileReader:FakeFileReader,document:{body:node(),hidden:false,fullscreenElement:null,exitFullscreen(){},addEventListener(type,fn){documentEvents[type]=fn},getElementById:id=>elements[id],createElement:node},performance:{now:()=>10},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},setInterval(fn){const id=++timerId;intervals.set(id,fn);return id},clearInterval(id){intervals.delete(id)},Map,Promise,Error,String,Number,Math,JSON};
  vm.runInNewContext(script,context);
  return {calls,sockets,timers,elements,openTargets,displayModes,windowEvents,documentEvents,intervals,document:context.document};
}

test('hidden or closed viewer stops sending immediately',()=>{
  const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,name:'Primary',primary:true}]};
  for (const event of ['hidden','pagehide']) {
    const h=harness(state,state); const socket=h.sockets[0]; socket.onopen();
    assert.equal(h.intervals.size,1);
    if(event==='hidden'){h.document.hidden=true;h.documentEvents.visibilitychange();}else h.windowEvents.pagehide();
    assert.equal(socket.readyState,3);
    assert.equal(socket.sent.at(-1).type,'pause');
    assert.equal(h.intervals.size,0);
    assert.equal(h.elements.toggle.textContent,'متابعة');
    // Restoration is tested separately; hidden views must stop immediately.
    assert.equal(h.sockets.length,1);
  }
});

test('viewer recovers state and opens the private websocket stream',async()=>{
  const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',viewerUrl:'https://bridge/viewer?ticket=secret',monitors:[{index:0,name:'Primary',width:1200,height:800,primary:true},{index:1,name:'Second',width:1200,height:800,primary:false}]};
  const h=harness(null,state);
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(h.calls[0].name,'live_view_state');
  assert.equal(h.elements.monitor.value,'1');
  assert.equal(h.sockets[0].url,state.streamUrl);
  assert.equal(h.openTargets[0].href,state.viewerUrl);
  h.sockets[0].onopen();
  assert.deepEqual(h.sockets[0].sent[0],{type:'select',screen:1,mode:'jpeg'});
});

test('viewer times out a stalled ChatGPT state call and schedules retry',async()=>{
  const html=readFileSync(new URL('./live-view.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1]?.replace('__GPT_US_BOOTSTRAP_STATE__','null');
  const timers=new Map();let timerId=0;const node=()=>({textContent:'',classList:{add(){},remove(){}},replaceChildren(){},addEventListener(){}});
  const elements=Object.fromEntries(['screen','frame','video','message','status','monitor','toggle','audio','expand','settingsToggle','controlSettings','controlStatus','touchpad','padToggle','keyboardToggle','padPanel','keyboardPanel','remoteText','sendText','leftClick','rightClick','doubleClick','enterKey','backspaceKey','tabKey','escapeKey'].map(id=>[id,node()]));
  const window={parent:{postMessage(){}},addEventListener(){},openai:{callTool(){return new Promise(()=>{});}}};
  vm.runInNewContext(script,{window,WebSocket:class{},Blob:class{},FileReader:class{},document:{body:{style:{setProperty(){}},classList:{add(){},remove(){}}},hidden:false,fullscreenElement:null,exitFullscreen(){},addEventListener(){},getElementById:id=>elements[id],createElement:node},performance:{now:()=>5},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},Map,Promise,Error,String,Number,Math,JSON});
  for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.match(elements.status.textContent,/تعذر جلب بيانات الاتصال/);
});

test('viewer starts directly from authenticated resource state',()=>{
  const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,name:'Primary',width:1200,height:800,primary:true}]};
  const h=harness(state,state);
  assert.equal(h.elements.monitor.value,'0');
  assert.equal(h.sockets[0].url,state.streamUrl);
  assert.equal(h.calls.length,0);
});

test('expand button grows inline and keeps ChatGPT below the viewer',async()=>{
  const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,name:'Primary',width:1200,height:800,primary:true}]};
  const h=harness(state,state);
  await h.elements.expand.listeners.click();
  assert.deepEqual(h.displayModes,['inline']);
  assert.equal(h.elements.expand.textContent,'الحجم العادي');
  await h.elements.expand.listeners.click();
  assert.deepEqual(h.displayModes,['inline']);
  assert.equal(h.elements.expand.textContent,'تكبير داخل المحادثة');
});


test('mobile visibility restoration requests fresh credentials without reloading',async()=>{
 const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,name:'Primary',primary:true}]};
 const h=harness(state,state);h.sockets[0].onopen();
 h.document.hidden=true;h.documentEvents.visibilitychange();
 h.document.hidden=false;h.documentEvents.visibilitychange();
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(h.calls.at(-1).name,'live_view_state');
 assert.equal(h.sockets.length,2);
});
test('browser video stays in waiting state until a decoded frame exists',()=>{
 const state={connected:true,browserCapture:{active:true,connected:true},streamUrl:'wss://bridge/live?ticket=secret',monitors:[]};
 const h=harness(state,state);
 assert.equal(h.elements.monitor.value,'browser');
 h.elements.video.listeners.loadeddata();
 assert.equal(h.elements.screen.classList.ready,true);
});
test('socket opening while mobile is hidden resumes on visibility restoration',async()=>{
 const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,primary:true}]};
 const h=harness(state,state);h.document.hidden=true;h.sockets[0].onopen();
 h.document.hidden=false;h.documentEvents.visibilitychange();
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(h.sockets.length,2);
 assert.equal(h.elements.toggle.textContent,'إيقاف مؤقت');
 assert.doesNotMatch(h.elements.message.textContent,/متوقف/);
});
test('mobile pageshow restores a suspended view but not a manual pause',async()=>{
 const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,primary:true}]};
 const h=harness(state,state);h.windowEvents.pagehide();h.windowEvents.pageshow();
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(h.sockets.length,2);
 h.elements.toggle.listeners.click();h.windowEvents.pagehide();h.windowEvents.pageshow();
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(h.sockets.length,2);
});
test('viewer accepts text JSON tool responses when structuredContent is omitted',async()=>{
 const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,primary:true}]};
 const h=harness({content:[{type:'text',text:JSON.stringify(state)}]},state);
 assert.equal(h.sockets.length,1);
 assert.match(h.elements.message.textContent,/أول إطار/);
});
