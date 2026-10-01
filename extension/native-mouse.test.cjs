const {test}=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const source=fs.readFileSync(__dirname+"/background.js","utf8");
function harness(failPress=false){
  const calls=[];
  const context={Map,Number,Error,ensureCdp:async()=>{},chrome:{debugger:{sendCommand:async(_,method,args)=>{
    calls.push(args);
    if(failPress&&args.type==="mousePressed")throw new Error("Disconnected");
  }}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("const nativeButtons ="),source.indexOf("async function nativeMousePath"))+";globalThis.act=nativeMouseAction;",context);
  return {calls,act:context.act};
}
test("right click sends native move, press and release",async()=>{
  const h=harness();await h.act(1,{kind:"right",x:10,y:20});
  assert.deepEqual(h.calls.map(c=>[c.type,c.button,c.buttons]),[["mouseMoved","none",0],["mousePressed","right",2],["mouseReleased","right",0]]);
});
test("double click carries increasing click count",async()=>{
  const h=harness();await h.act(1,{kind:"double",x:10,y:20});
  assert.deepEqual(h.calls.filter(c=>c.type==="mousePressed").map(c=>c.clickCount),[1,2]);
});
test("held buttons are isolated per browser tab",async()=>{
  const h=harness();await h.act(1,{kind:"mousedown",x:10,y:20});
  await h.act(2,{kind:"mousemove",x:15,y:25});
  assert.equal(h.calls.at(-1).buttons,0);
  await h.act(1,{kind:"mousemove",x:15,y:25});
  assert.equal(h.calls.at(-1).buttons,1);
  await h.act(1,{kind:"mouseup",x:15,y:25});
  assert.equal(h.calls.at(-1).buttons,0);
});
test("invalid input causes no browser action",async()=>{
  const h=harness();await assert.rejects(h.act(1,{kind:"right",x:NaN,y:20}));
  assert.equal(h.calls.length,0);
});
test("failed click attempts release and reports failure",async()=>{
  const h=harness(true);await assert.rejects(h.act(1,{kind:"right",x:10,y:20}),/Disconnected/);
  assert.equal(h.calls.at(-1).type,"mouseReleased");
});
