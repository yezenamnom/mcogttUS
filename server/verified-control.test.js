import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TargetState,verifiedControl,compareState} from './verified-control.js';

test('Observe Act Observe Compare and safe fallback ordering',async()=>{
 const events=[];let value='old';
 const result=await verifiedControl({settleMs:0,layers:['os','uia','vision'],expect:{path:'element.value',operator:'equals',value:'new'},observe:async()=>{events.push('observe');return {element:{value}}},act:async layer=>{events.push(layer);if(layer==='os')return {notExecuted:true,retrySafe:true};value='new';return {executed:true};}});
 assert.deepEqual(events,['observe','os','uia','observe']);assert.equal(result.verified,true);assert.equal(result.comparison.changed,true);
});
test('an action with uncertain result is never replayed through another layer',async()=>{
 for(const outcome of ['throw','mismatch']){
  const calls=[];const result=await verifiedControl({settleMs:0,layers:['dom','cdp','vision'],expect:{path:'url',operator:'equals',value:'expected'},observe:async()=>({url:'old'}),act:async layer=>{calls.push(layer);if(outcome==='throw')throw Error('Disconnected after send');return {executed:true};}});
  assert.deepEqual(calls,['dom']);assert.equal(result.verified,false);assert.equal(result.retrySafe,false);
 }
});
test('blocked input does not fall back and timestamp changes do not count',async()=>{
 const result=await verifiedControl({layers:['uia','vision'],expect:{path:'window.active',operator:'equals',value:true},observe:async()=>({window:{active:false}}),act:async()=>({notExecuted:true,retrySafe:false,reason:'Permission disabled'})});assert.equal(result.status,'blocked');assert.equal(result.attempts.length,1);
 assert.equal(compareState({window:1,observedAt:'a'},{window:1,observedAt:'b'},{path:'window',operator:'changed'}).matched,false);
 assert.equal(compareState({window:1,observedAt:'a'},{window:1,observedAt:'b'},{path:'window',operator:'equals',value:1}).changed,false);
});
test('target screen window tab and element survive store reload',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-targets-'));
 try{const path=join(dir,'targets.json'),store=new TargetState(path);store.set('desktop',{hwnd:123,screen:1,element:{automationId:'save'}});store.set('browser',{tabId:42,element:{selector:'#submit'}});const restored=new TargetState(path);assert.equal(restored.get('desktop').hwnd,123);assert.equal(restored.get('desktop').screen,1);assert.equal(restored.get('browser').element.selector,'#submit');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('delayed UI change is observed repeatedly without repeating the action',async()=>{
 let reads=0,actions=0;const result=await verifiedControl({settleMs:0,verificationMs:500,layers:['dom','vision'],expect:{path:'url',operator:'equals',value:'new'},observe:async()=>({url:++reads>=3?'new':'old'}),act:async()=>{actions++;return {executed:true};}});
 assert.equal(result.verified,true);assert.equal(actions,1);assert.equal(result.observations,2);
});
test('failed observation and closed target send no action',async()=>{
 for(const observe of [async()=>{throw Error('offline')},async()=>({targetClosed:true})]){
 let actions=0;const result=await verifiedControl({observe,act:async()=>{actions++},layers:['os'],expect:{path:'window',operator:'absent'}});
 assert.equal(actions,0);assert.equal(result.verified,false);
 }
});
test('target commands serialize and failures release the queue',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-queue-'));try{
 const store=new TargetState(join(dir,'targets.json')),events=[];
 const first=store.run('desktop',async()=>{events.push('first');await new Promise(r=>setTimeout(r,10));throw Error('failed');});
 const second=store.run('desktop',async()=>{events.push('second');return 2;});
 await assert.rejects(first);assert.equal(await second,2);assert.deepEqual(events,['first','second']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('container replacement restores only an explicitly saved valid target and element',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-restore-'));try{
 const store=new TargetState(join(dir,'targets.json'));
 const restored=await store.resolve('desktop',async()=>({hwnd:42,element:{name:'Editor'},identity:{window:{hwnd:42}}}));
 assert.equal(restored.hwnd,42);assert.equal(restored.element.name,'Editor');
 assert.equal((await store.resolve('desktop',async()=>{throw Error('must reuse saved target')})).hwnd,42);
 await assert.rejects(store.resolve('browser',async()=>null),/Select a persistent/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
