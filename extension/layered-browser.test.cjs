const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/background.js','utf8');
function harness(){
 const local={},session={};let closed=false;
 const tab={id:42,windowId:5,title:'Editor',url:'https://example.com'};
 const context={crypto:{randomUUID:()=> 'session-1'},chrome:{storage:{local:{get:async key=>({[key]:local[key]}),set:async value=>Object.assign(local,value)},session:{get:async key=>({[key]:session[key]}),set:async value=>Object.assign(session,value)}},tabs:{query:async()=>[tab],get:async()=>{if(closed)throw Error('closed');return tab}}},activeTab:async()=>({id:99}),Error,Number};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function pinnedTab'),source.indexOf('function layeredDOM')),context);
 return {context,local,session,close:()=>closed=true};
}
test('pinned tab survives service-worker calls, never falls back when closed',async()=>{
 const h=harness();await vm.runInContext('chooseWorkingTab({tabId:42})',h.context);
 assert.equal((await vm.runInContext('targetTab({})',h.context)).id,42);
 h.close();await assert.rejects(vm.runInContext('targetTab({})',h.context),/closed/);
});
test('browser restart invalidates reused tab identifiers and explicit mismatches',async()=>{
 const h=harness();await vm.runInContext('chooseWorkingTab({tabId:42})',h.context);
 await assert.rejects(vm.runInContext('targetTab({tabId:99})',h.context),/differs/);
 delete h.session.targetSession;await assert.rejects(vm.runInContext('targetTab({})',h.context),/session changed/);
});
test('ambiguous and disabled DOM elements cannot fall through to a mouse click',()=>{
 let clicks=0;const element={disabled:true,type:'text',tagName:'BUTTON',innerText:'Save',getAttribute:()=>null,getBoundingClientRect:()=>({x:0,y:0,width:20,height:20}),click:()=>clicks++};
 for(const matches of [[element],[element,element]]){
 const context={document:{querySelectorAll:()=>matches,body:{innerText:''},title:'Test'},location:{href:'https://example.com'},scrollY:0};vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function layeredDOM'),source.indexOf('async function browserLayerAct')),context);
 const result=vm.runInContext('layeredDOM({selector:"button",action:"click"})',context);
 assert.equal(result.notExecuted,true);assert.equal(result.retrySafe,false);
 }assert.equal(clicks,0);
});
