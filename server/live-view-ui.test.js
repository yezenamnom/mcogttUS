import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('viewer recovers missed opening notification and renders a private frame',async()=>{
  const html=readFileSync(new URL('./live-view.html',import.meta.url),'utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const timers=new Map();let timerId=0;const calls=[];
  const node=()=>({textContent:'',value:'',options:[],style:{},classList:{ready:false,add(){this.ready=true},contains(){return this.ready}},replaceChildren(...items){this.options=items},addEventListener(){}});
  const elements=Object.fromEntries(['screen','frame','message','status','monitor','toggle'].map(id=>[id,node()]));
  const window={parent:{postMessage(){}},addEventListener(){},openai:{async callTool(name,args){calls.push({name,args});
    if(name==='live_view_state')return {structuredContent:{connected:true,monitors:[{index:0,name:'Primary',width:1200,height:800,primary:true},{index:1,name:'Second',width:1200,height:800,primary:false}]}};
    if(name==='live_view_frame')return {structuredContent:{frame:{dataUrl:'data:image/webp;base64,QUJD',screen:1}}};
    throw Error('unexpected tool');
  }}};
  const context={window,document:{hidden:false,getElementById:id=>elements[id],createElement:()=>node()},performance:{now:()=>5},
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},Map,Promise,Error,String,Number,Math};
  vm.runInNewContext(script,context);
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(calls[0].name,'live_view_state');
  assert.equal(elements.monitor.value,'1');
  const first=timers.entries().next().value;assert.ok(first);timers.delete(first[0]);first[1]();
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(calls[1].name,'live_view_frame');
  assert.equal(calls[1].args.screen,1);
  assert.equal(elements.frame.src,'data:image/webp;base64,QUJD');
  assert.equal(elements.screen.classList.ready,true);
});
