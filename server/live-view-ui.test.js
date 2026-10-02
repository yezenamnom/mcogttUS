import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function harness(initial=null, toolResult=null) {
  const html=readFileSync(new URL('./live-view.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1]?.replace('__GPT_US_BOOTSTRAP_STATE__',JSON.stringify(initial));
  const calls=[]; const sockets=[]; const timers=new Map(); let timerId=0;
  const node=()=>({textContent:'',value:'',src:'',options:[],listeners:{},style:{setProperty(){}},classList:{ready:false,add(){this.ready=true},remove(){this.ready=false}},replaceChildren(...items){this.options=items},addEventListener(type,fn){this.listeners[type]=fn},requestFullscreen(){}});
  const elements=Object.fromEntries(['screen','frame','video','message','status','monitor','toggle','audio','expand'].map(id=>[id,node()]));
  class FakeWebSocket { static OPEN=1; constructor(url){this.url=url;this.readyState=1;this.sent=[];sockets.push(this)} send(value){this.sent.push(JSON.parse(value))} close(){this.readyState=3} }
  const openTargets=[]; const displayModes=[];
  const window={parent:{postMessage(){}},addEventListener(){},openai:{displayMode:'inline',async callTool(name,args){calls.push({name,args});return {structuredContent:toolResult};},async requestDisplayMode({mode}){displayModes.push(mode);this.displayMode=mode;return {mode}},setOpenInAppUrl(target){openTargets.push(target)}}};
  class FakeFileReader { readAsDataURL(){this.result='data:image/webp;base64,QUJD';this.onload?.()} }
  const context={window,WebSocket:FakeWebSocket,Blob:class{},FileReader:FakeFileReader,document:{body:node(),hidden:false,fullscreenElement:null,exitFullscreen(){},addEventListener(){},getElementById:id=>elements[id],createElement:node},performance:{now:()=>10},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},Map,Promise,Error,String,Number,Math,JSON};
  vm.runInNewContext(script,context);
  return {calls,sockets,timers,elements,openTargets,displayModes};
}

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
  const elements=Object.fromEntries(['screen','frame','video','message','status','monitor','toggle','audio','expand'].map(id=>[id,node()]));
  const window={parent:{postMessage(){}},addEventListener(){},openai:{callTool(){return new Promise(()=>{});}}};
  vm.runInNewContext(script,{window,WebSocket:class{},Blob:class{},FileReader:class{},document:{body:{classList:{add(){},remove(){}}},hidden:false,fullscreenElement:null,exitFullscreen(){},addEventListener(){},getElementById:id=>elements[id],createElement:node},performance:{now:()=>5},setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},Map,Promise,Error,String,Number,Math,JSON});
  const timeout=timers.entries().next().value;timers.delete(timeout[0]);timeout[1]();
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

test('expand button asks ChatGPT for fullscreen while keeping the composer available',async()=>{
  const state={connected:true,streamUrl:'wss://bridge/live?ticket=secret',monitors:[{index:0,name:'Primary',width:1200,height:800,primary:true}]};
  const h=harness(state,state);
  await h.elements.expand.listeners.click();
  assert.deepEqual(h.displayModes,['fullscreen']);
  assert.equal(h.elements.expand.textContent,'العودة للحجم العادي');
  await h.elements.expand.listeners.click();
  assert.deepEqual(h.displayModes,['fullscreen','inline']);
});


