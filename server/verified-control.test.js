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
