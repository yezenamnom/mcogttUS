import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Instructions,validateInstructions} from './instructions.js';

test('instructions validate, back up, persist, detect stale saves and restore default',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-instructions-'));
 try{
  const defaults=fileURLToPath(new URL('./OPERATING_RULES_AR.md',import.meta.url));
  const path=join(dir,'current.md'),store=new Instructions(defaults,path),initial=store.get();
  assert.equal(initial.version,'1.1.1');
  const modified=initial.text.replace('Version: 1.1.1','Version: 1.2.0')+'\nقاعدة إضافية: تحقق من الهدف.\n';
  const saved=store.update(modified,initial.sha256);
  assert.equal(readFileSync(saved.backup,'utf8'),initial.text);
  assert.equal(new Instructions(defaults,path).get().version,'1.2.0');
  assert.throws(()=>store.update(initial.text,initial.sha256),/reload/);
  assert.throws(()=>store.update('# invalid',saved.sha256),/title/);
  assert.equal(store.get().text,modified);
  store.reset(saved.sha256);assert.equal(store.get().text,initial.text);
  assert.equal(readdirSync(join(dir,'instruction-backups')).length,2);
  assert.throws(()=>validateInstructions(initial.text.replace('## Safety','## Other')),/Safety/);
  assert.throws(()=>validateInstructions(initial.text.replace('2026-10-02','2026-02-30')),/Updated/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
