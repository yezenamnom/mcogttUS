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
  socket.on("message",data=>{
   const m=JSON.parse(data);commands.push(m);
   socket.send(JSON.stringify({type:"result",id:m.id,ok:true,result:{executed:true,kind:m.args.kind,x:m.args.x,y:m.args.y}}));
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
  const reply=await rpc(3,"tools/call",{name:"desktop_mouse_action",arguments:{kind:"click",x:-100,y:50}});
  assert.equal(reply.result.isError,undefined);
  assert.equal(commands.length,1);
  assert.equal(commands[0].command,"desktop_mouse_action");
  assert.equal(commands[0].args.x,-100);
  assert.equal(JSON.parse(reply.result.content[0].text).executed,true);
  assert.equal((await (await fetch(base+"/health")).json()).desktopConnected,true);
 }finally{socket?.close();child.kill();await new Promise(r=>child.exitCode!==null?r():child.once("exit",r));}
});
