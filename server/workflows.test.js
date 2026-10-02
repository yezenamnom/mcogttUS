import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workflows} from './workflows.js';

test('verified progress persists, uncertain actions are not repeated',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-workflows-'));
 try{
  const path=join(dir,'state.json');const engine=new Workflows(path);
  engine.create('copy file',[{command:'desktop_copy_file',expect:{kind:'file_exists'}}]);
  let sent=0;
  await engine.next(async()=>{sent++;throw Error('Connection lost')},async()=>false);
  assert.equal(engine.state.status,'needs_review');assert.equal(sent,1);
  const recovered=new Workflows(path);
  await recovered.next(async()=>sent++,async()=>false);
  assert.equal(sent,1);assert.equal(recovered.state.index,0);
  await recovered.next(async()=>sent++,async()=>true);
  assert.equal(sent,1);assert.equal(recovered.state.status,'complete');
  assert.equal(new Workflows(path).state.history[0].verified,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('restart during an action requires verification instead of replay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-workflows-'));
 try{
  const path=join(dir,'state.json'),engine=new Workflows(path);
  engine.create('task',[{command:'click',expect:{kind:'page_text'}}]);
  engine.state.status='running';engine.save();
  assert.equal(new Workflows(path).state.status,'needs_review');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
