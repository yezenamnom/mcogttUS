import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';

test('instruction editor API and voice batch: target, original images, one bridge call',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gpt-voice-')),port=39192,base='http://127.0.0.1:'+port,token='voice-test';
 const child=spawn(process.execPath,['server.js'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),BRIDGE_TOKEN:token,GPT_US_INSTRUCTIONS_PATH:join(dir,'instructions.md'),WORKFLOW_STATE_PATH:join(dir,'workflow.json')},stdio:'pipe'});
 let logs='',socket;child.stderr.on('data',chunk=>logs+=chunk);
 try{
  for(let i=0;i<80;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,100));}
  const auth={authorization:'Bearer '+token,'content-type':'application/json'};
  assert.equal((await fetch(base+'/instructions')).status,401);
  const initial=await (await fetch(base+'/instructions',{headers:auth})).json();
  const invalid=await fetch(base+'/instructions',{method:'PUT',headers:auth,body:JSON.stringify({text:'# invalid',expectedHash:initial.sha256})});assert.equal(invalid.status,400);
  const changed=initial.text.replace('Version: 1.1.4','Version: 1.2.0');
  const saved=await (await fetch(base+'/instructions',{method:'PUT',headers:auth,body:JSON.stringify({text:changed,expectedHash:initial.sha256})})).json();assert.equal(saved.version,'1.2.0');assert.ok(saved.backup);
  async function rpc(id,method,params){const response=await fetch(base+'/mcp',{method:'POST',headers:{...auth,accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});assert.equal(response.status,200);const text=await response.text();return JSON.parse(text.startsWith('{')?text:text.split('\n').find(line=>line.startsWith('data:')).slice(5));}
  const init=await rpc(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'voice-test',version:'1'}});assert.match(init.result.instructions,/Version: 1.2.0/);
  socket=new WebSocket('ws://127.0.0.1:'+port+'/desktop?token='+token);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
  let selected=null;const commands=[];
  const shot={data:'QUJD',mimeType:'image/png',x:0,y:0,width:2560,height:1440,originalResolution:true};
  socket.on('message',raw=>{const command=JSON.parse(raw);commands.push(command);let result;
    if(command.args.kind==='select'){selected=command.args.hwnd;result={selected:true,window:{hwnd:selected}};}
    else if(command.args.kind==='batch'){result={completed:true,window:{hwnd:selected},results:command.args.actions.map(action=>({kind:action.kind,executed:true,uiVerified:false})),evidence:{windowImage:shot,screenImage:shot,crop:{...shot,width:300,height:100}}};}
    else result={active:{hwnd:999},target:{hwnd:selected}};
    socket.send(JSON.stringify({type:'result',id:command.id,ok:true,result}));
  });
  await rpc(2,'tools/call',{name:'desktop_select_window',arguments:{hwnd:123}});
  const before=commands.length;
  const batch=await rpc(3,'tools/call',{name:'desktop_voice_batch',arguments:{actions:[{kind:'activate'},{kind:'type',text:'مرحبا'},{kind:'keys',keys:['CTRL','S']}],region:{x:0,y:0,width:300,height:100}}});
  assert.equal(commands.length-before,1,'three actions and final evidence use one desktop round trip');
  assert.equal(batch.result.content.filter(item=>item.type==='image').length,3);
  const metadata=JSON.parse(batch.result.content.find(item=>item.type==='text').text);assert.equal(metadata.window.hwnd,123);assert.equal(metadata.evidence.windowImage.width,2560);assert.equal(metadata.evidence.crop.width,300);assert.ok(!JSON.stringify(metadata).includes('QUJD'));
  const state=await rpc(4,'tools/call',{name:'desktop_current_window',arguments:{}});assert.equal(JSON.parse(state.result.content[0].text).target.hwnd,123);
  const reset=await fetch(base+'/instructions/reset',{method:'POST',headers:auth,body:JSON.stringify({expectedHash:saved.sha256})});assert.equal(reset.status,200);assert.equal((await reset.json()).version,'1.1.4');
 }finally{socket?.close();child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));rmSync(dir,{recursive:true,force:true});}
});
