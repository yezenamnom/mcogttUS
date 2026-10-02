const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('new recorder generations send ordered initialization chunks and stop rotation',async()=>{
 const recorders=[],sockets=[],intervals=new Map();let intervalId=0;
 const track={getSettings:()=>({width:1920,height:1080,frameRate:60}),addEventListener(){},stop(){}};
 const stream={getVideoTracks:()=>[track],getAudioTracks:()=>[],getTracks:()=>[track]};
 class Recorder{
  static isTypeSupported(){return true}
  constructor(){this.state='inactive';this.mimeType='video/webm';this.events={};recorders.push(this)}
  start(){this.state='recording'}
  stop(){this.state='inactive';this.events.stop?.()}
  addEventListener(name,fn){this.events[name]=fn}
 }
 class Socket{
  static OPEN=1;
  constructor(){this.readyState=1;this.sent=[];sockets.push(this);queueMicrotask(()=>this.onopen?.())}
  send(value){this.sent.push(value)} close(){this.readyState=3}
 }
 const context={chrome:{storage:{local:{get:async()=>({bridgeUrl:'https://example.com',bridgeToken:'test'})}},runtime:{sendMessage:async()=>{},onMessage:{addListener(){}}}},navigator:{mediaDevices:{getUserMedia:async()=>stream}},MediaRecorder:Recorder,WebSocket:Socket,setTimeout,clearTimeout,setInterval(fn){const id=++intervalId;intervals.set(id,fn);return id},clearInterval(id){intervals.delete(id)},Promise,Error,Date};
 vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/offscreen.js','utf8'),context);
 await vm.runInContext('startCapture("test")',context);
 let release;
 recorders[0].ondataavailable({data:{size:3,arrayBuffer:()=>new Promise(resolve=>release=resolve)}});
 await Promise.resolve();
 [...intervals.values()][0]();assert.equal(recorders.length,2);
 const second=new Uint8Array([4,5,6]).buffer;
 recorders[1].ondataavailable({data:{size:3,arrayBuffer:async()=>second}});
 release(new Uint8Array([1,2,3]).buffer);
 for(let i=0;i<15;i++)await Promise.resolve();
 const meta=sockets[0].sent.filter(value=>typeof value==='string').map(JSON.parse).filter(value=>value.type==='capture_chunk');
 assert.equal(meta.length,2);assert.equal(meta[0].sequence,0);assert.equal(meta[1].sequence,1);
 assert.equal(meta[0].segmentStart,true);assert.equal(meta[1].segmentStart,true);
 assert.notEqual(meta[0].segment,meta[1].segment);
 vm.runInContext('stopCapture()',context);assert.equal(intervals.size,0);
});
