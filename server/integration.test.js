import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {WebSocket} from "ws";

test("MCP routes combined mouse operations to desktop and serves health",async()=>{
 const port=39187,base="http://127.0.0.1:"+port,token="integration-test-only";
 const child=spawn(process.execPath,["server.js"],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),BRIDGE_TOKEN:token},stdio:"pipe"});
 let logs="";child.stderr.on("data",d=>logs+=d);child.stdout.on("data",d=>logs+=d);
 let socket;
 try{
  let ready=false;
  for(let n=0;n<80;n++){
   if(child.exitCode!==null)throw new Error(logs);
   try{const r=await fetch(base+"/health");if(r.ok){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ready,"server starts: "+logs);
  socket=new WebSocket(base.replace("http:","ws:")+"/desktop?token="+token);
  await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
  const commands=[];
  let minimized=false;
  socket.on("message",data=>{
   const m=JSON.parse(data);commands.push(m);
   let result=m.command==='desktop_screenshot'?{data:'QUJD',mimeType:'image/png',width:2560,height:1440}:{executed:true,kind:m.args.kind,x:m.args.x,y:m.args.y};
   if(m.command==='desktop_control'&&m.args.kind==='select')result={selected:true,window:{hwnd:m.args.hwnd}};
   if(m.command==='desktop_layer_observe')result={window:{hwnd:123,minimized}};
   if(m.command==='desktop_layer_act'){
     if(m.args.action==='click')result={notExecuted:true,retrySafe:false,reason:'disabled'};
     else{minimized=m.args.action==='minimize';result={executed:true};}
   }
   socket.send(JSON.stringify({type:"result",id:m.id,ok:true,result}));
  });
  let session;
  async function rpc(id,method,params){
   const headers={"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+token};
   if(session)headers["mcp-session-id"]=session;
   const r=await fetch(base+"/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id,method,params})});
   assert.ok(r.ok,await r.clone().text());session=r.headers.get("mcp-session-id")||session;
   const body=await r.text();
   const data=body.startsWith("{")?body:body.split("\n").find(l=>l.startsWith("data:"))?.slice(5);
   return JSON.parse(data);
  }
  await rpc(1,"initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"test",version:"1"}});
  const denied=await fetch(base+"/mcp",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  assert.equal(denied.status,401);
  const wrong=await fetch(base+"/mcp",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer wrong"},body:"{}"});
  assert.equal(wrong.status,401);
  const list=await rpc(2,"tools/list",{});
  assert.ok(list.result.tools.some(t=>t.name==="desktop_mouse_action"));
  assert.deepEqual(list.result.tools.find(t=>t.name==="desktop_mouse_action")._meta.securitySchemes,[{type:"oauth2",scopes:["computer:control"]}]);
  assert.ok(list.result.tools.some(t=>t.name==="gpt_us.desktop_mouse_action"));
  const reply=await rpc(3,"tools/call",{name:"desktop_mouse_action",arguments:{kind:"click",x:-100,y:50}});
  assert.equal(reply.result.isError,undefined);
  assert.equal(commands.length,1);
  assert.equal(commands[0].command,"desktop_mouse_action");
  assert.equal(commands[0].args.x,-100);
  assert.equal(JSON.parse(reply.result.content[0].text).executed,true);
  const qualified=await rpc(4,"tools/call",{name:"gpt_us.desktop_mouse_action",arguments:{kind:"move",x:-200,y:75}});
  assert.equal(qualified.result.isError,undefined);
  assert.equal(commands.length,2);
  assert.equal(commands[1].command,"desktop_mouse_action");
  assert.equal(commands[1].args.kind,"move");
  const cached=await rpc(5,"tools/call",{name:"desktop_report_latest",arguments:{kind:"workspace"}});
  assert.equal(cached.result.isError,undefined);
  assert.equal(commands.at(-1).command,"desktop_mouse_action");
  assert.equal(commands.at(-1).args.kind,"report_latest");
  assert.equal(commands.at(-1).args.reportKind,"workspace");
  const shell=await rpc(6,"tools/call",{name:"desktop_run_command",arguments:{command:"whoami"}});
  assert.equal(shell.result.isError,undefined);
  assert.equal(commands.at(-1).args.kind,"run_command");
  assert.equal(commands.at(-1).args.command,"whoami");
  const screenshot=await rpc(7,'tools/call',{name:'batch_actions',arguments:{actions:[{command:'desktop_screenshot'}]}});
  assert.equal(screenshot.result.content[0].type,'image');
  assert.equal(screenshot.result.content[0].data,'QUJD');
  const screenshotMeta=JSON.parse(screenshot.result.content[1].text);
  assert.equal(screenshotMeta.results[0].result.width,2560);
  assert.equal(screenshotMeta.results[0].result.data,undefined);
  await rpc(8,'tools/call',{name:'control_target',arguments:{domain:'desktop',hwnd:123}});
  const steps=[{domain:'desktop',action:'minimize',expect:{path:'window.minimized',operator:'equals',value:true}},{domain:'desktop',action:'restore',expect:{path:'window.minimized',operator:'equals',value:false}}];
  const batch=await rpc(9,'tools/call',{name:'verified_control_batch',arguments:{actions:steps}});
  assert.equal(JSON.parse(batch.result.content[0].text).completed,true);
  const stopped=await rpc(10,'tools/call',{name:'verified_control_batch',arguments:{actions:[{domain:'desktop',action:'click',expect:{path:'window.minimized',operator:'equals',value:false}},...steps]}});
  const stopResult=JSON.parse(stopped.result.content[0].text);
  assert.equal(stopResult.completed,false);assert.equal(stopResult.results.length,1);assert.equal(stopResult.results[0].status,'blocked');
  assert.equal((await (await fetch(base+"/health")).json()).desktopConnected,true);
 }finally{socket?.close();child.kill();await new Promise(r=>child.exitCode!==null?r():child.once("exit",r));}
});
