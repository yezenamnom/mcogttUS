import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';

export class TargetState {
 constructor(path){this.path=path;this.state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};this.queues=new Map();}
 async run(domain,operation){const previous=this.queues.get(domain)||Promise.resolve();const current=previous.catch(()=>{}).then(operation);this.queues.set(domain,current);try{return await current;}finally{if(this.queues.get(domain)===current)this.queues.delete(domain);}}
 set(domain,target){this.state[domain]={...target,updatedAt:new Date().toISOString()};mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify(this.state));renameSync(this.path+'.tmp',this.path);return this.state[domain];}
 get(domain){if(!this.state[domain])throw Error('Select a persistent '+domain+' target first');return this.state[domain];}
}

export function compareState(before,after,expect){
 const read=(object,path)=>path.split('.').reduce((value,key)=>value?.[key],object);
 const actual=read(after,expect.path),previous=read(before,expect.path);
 const stable=value=>JSON.stringify(value,(key,value)=>["observedAt","at"].includes(key)?undefined:value);
 const matched=expect.operator==='equals'?actual!==undefined&&JSON.stringify(actual)===JSON.stringify(expect.value):expect.operator==='contains'?typeof actual==='string'&&actual.includes(String(expect.value)):expect.operator==='absent'?actual===undefined||actual===null:expect.operator==='changed'?actual!==undefined&&stable(previous)!==stable(actual):false;
 return {matched,changed:stable(before)!==stable(after),path:expect.path,previous,actual};
}

// Fallback is permitted only when the lower layer explicitly proves no action was sent.
export async function verifiedControl({observe,act,layers,expect,settleMs=100,verificationMs=settleMs===0?0:2000}){
 const started=Date.now();let before;const attempts=[];
 try{before=await observe();}catch(error){return {verified:false,status:'observation_unavailable',error:error.message,attempts,retrySafe:true};}
 if(!before||before.targetClosed)return {verified:false,status:'target_unavailable',before,attempts,retrySafe:false};
 for(const layer of layers){
  let result;
  try{result=await act(layer);}catch(error){return {verified:false,status:'outcome_unknown',before,attempts:[...attempts,{layer,error:error.message}],retrySafe:false};}
  attempts.push({layer,...result});
  if(result.notExecuted===true){if(result.retrySafe===true)continue;return {verified:false,status:'blocked',before,attempts,retrySafe:false};}
  if(result.executed!==true)return {verified:false,status:'outcome_unknown',before,attempts,retrySafe:false};
  if(settleMs)await new Promise(resolve=>setTimeout(resolve,settleMs));
  let after,comparison;const deadline=Date.now()+verificationMs;let observations=0;
  do{
   try{after=await observe();observations++;}catch(error){return {verified:false,status:'verification_unavailable',before,after,attempts,error:error.message,retrySafe:false};}
   comparison=compareState(before,after,expect);
   if(comparison.matched||Date.now()>=deadline)break;
   await new Promise(resolve=>setTimeout(resolve,Math.min(100,deadline-Date.now())));
  }while(true);
  return {verified:comparison.matched,status:comparison.matched?'verified':'needs_review',before,after,comparison,attempts,observations,elapsedMs:Date.now()-started,retrySafe:false};
 }
 return {verified:false,status:'unsupported',before,attempts,retrySafe:true};
}
