// Explicit multi-tab identities. Never substitute an active tab for a lost target.
export class TargetManager {
 constructor(api,{uuid=()=>crypto.randomUUID(),now=()=>new Date().toISOString()}={}){this.api=api;this.uuid=uuid;this.now=now;this.queue=Promise.resolve();}
 mutate(fn){const next=this.queue.catch(()=>{}).then(fn);this.queue=next;return next;}
 async session(){let {targetSession}=await this.api.storage.session.get('targetSession');const {browserTargetEpoch}=await this.api.storage.local.get('browserTargetEpoch');if(!targetSession){targetSession=browserTargetEpoch||this.uuid();await this.api.storage.session.set({targetSession});}if(browserTargetEpoch!==targetSession)await this.api.storage.local.set({browserTargetEpoch:targetSession});return targetSession;}
 async invalidateSession(){return this.mutate(async()=>{const targetSession=this.uuid();await this.api.storage.local.set({browserTargetEpoch:targetSession});await this.api.storage.session.set({targetSession});});}
 async load(){return (await this.api.storage.local.get('browserTargets')).browserTargets||{};}
 async save(targets){await this.api.storage.local.set({browserTargets:targets});}
 async add(args={}){return this.mutate(async()=>{
  const tabs=await this.api.tabs.query({});
  const candidates=args.tabId!==undefined?tabs.filter(t=>t.id===args.tabId):args.url?tabs.filter(t=>t.url===args.url):tabs.filter(t=>t.active&&t.windowId===args.windowId);
  if(candidates.length!==1)throw Error('TARGET_AMBIGUOUS: specify one exact tabId or URL');
  const tab=candidates[0];if(!/^https?:\/\//.test(tab.url||''))throw Error('TARGET_RESTRICTED: only HTTP(S) pages supported');
  const targets=await this.load(),session=await this.session();
  const existing=Object.values(targets).find(t=>t.chromeTabId===tab.id&&t.session===session);
  const target={targetId:existing?.targetId||this.uuid(),chromeTabId:tab.id,windowId:tab.windowId,url:tab.url,title:tab.title||'',status:'CONNECTED',attachedAt:existing?.attachedAt||this.now(),lastSeen:this.now(),session,cdpAttached:null,contentScriptConnected:null,domRevision:null,taskId:args.taskId||null,role:args.role||existing?.role||null};
  targets[target.targetId]=target;await this.save(targets);return target;
 });}
 async refresh(target){
  if(target.session!==await this.session())return {...target,status:'SESSION_EXPIRED'};
  const tab=await this.api.tabs.get(target.chromeTabId).catch(()=>null);
  if(!tab)return {...target,status:'TAB_CLOSED'};
  if(!/^https?:\/\//.test(tab.url||''))return {...target,status:'TARGET_RESTRICTED'};
  return {...target,windowId:tab.windowId,url:tab.url,title:tab.title||'',lastSeen:this.now(),status:'CONNECTED'};
 }
 async list(){return this.mutate(async()=>{const targets=await this.load();for(const id of Object.keys(targets))targets[id]=await this.refresh(targets[id]);await this.save(targets);return Object.values(targets);});}
 async get(id){const target=(await this.list()).find(t=>t.targetId===id);if(!target)throw Error('TARGET_NOT_FOUND');return target;}
 async resolve(id){const target=await this.get(id);if(target.status!=='CONNECTED')throw Error(target.status+': reselect explicitly');return this.api.tabs.get(target.chromeTabId);}
 async remove(id){return this.mutate(async()=>{const targets=await this.load();if(!targets[id])throw Error('TARGET_NOT_FOUND');delete targets[id];await this.save(targets);return {removed:true,targetId:id};});}
 async clear(){return this.mutate(async()=>{await this.save({});return {cleared:true};});}
 async focus(id){const tab=await this.resolve(id);await this.api.tabs.update(tab.id,{active:true});await this.api.windows.update(tab.windowId,{focused:true});return this.get(id);}
}

export function agentIndicator(state){
 let host=document.getElementById('__gptus_blue_agent');
 if(!host){host=document.createElement('div');host.id='__gptus_blue_agent';host.setAttribute('aria-hidden','true');const root=host.attachShadow({mode:'closed'});root.innerHTML='<style>:host{pointer-events:none!important;position:fixed!important;inset:0!important;z-index:2147483645!important;contain:layout style paint}.edge{position:absolute;inset:2px;border:2px solid #398bff;border-radius:6px}.badge{position:absolute;top:8px;right:12px;color:white;background:#123e78;padding:5px 10px;border-radius:12px;font:12px system-ui}</style><div class="edge"></div><div class="badge"></div>';host.__badge=root.querySelector('.badge');document.documentElement.append(host);}
 clearTimeout(host.__timer);host.__badge.textContent='GPT Agent · '+state;
 host.style.setProperty('display',state==='IDLE'?'none':'block','important');
 host.__timer=setTimeout(()=>host.style.setProperty('display','none','important'),state==='SUCCESS'||state==='ERROR'?900:2500);
}
