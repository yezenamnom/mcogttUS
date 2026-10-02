import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

// A command acknowledgement is not evidence that its intended effect happened.
export class Workflows {
  constructor(path) {
    this.path=path; this.running=false;
    this.state=null;
    if(existsSync(path)) {
      this.state=JSON.parse(readFileSync(path,'utf8'));
      if(this.state?.status==='running'){
        this.state.status='needs_review';this.state.reason='Server restarted; verify the interrupted step before continuing';
        this.save();
      }
    }
  }
  save(){mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify(this.state,null,2));renameSync(this.path+'.tmp',this.path);}
  create(task,steps){
    if(this.running || this.state && !['complete','cancelled'].includes(this.state.status))throw Error('Finish or cancel the current workflow first');
    this.state={id:randomUUID(),task,steps,index:0,status:'ready',history:[],createdAt:new Date().toISOString()};this.save();return this.state;
  }
  pause(){if(this.state){this.state.status='paused';this.save();}return this.state;}
  cancel(){if(this.running)throw Error('Pause first and wait for the current step to finish');if(this.state){this.state.status='cancelled';this.save();}return this.state;}
  async next(execute,check){
    if(this.running)throw Error('A workflow step is already running');
    const state=this.state;
    if(!state || ['complete','cancelled'].includes(state.status))throw Error('No active workflow');
    const step=state.steps[state.index];this.running=true;
    try {
      // Uncertain commands are never automatically sent a second time.
      if(state.status==='needs_review' || state.uncertain){
        if(!await check(step.expect))return state;
      }else {
        state.status='running';state.reason=null;state.uncertain=true;this.save();
        try {
          await execute(step.command,step.args||{});
          let verified=false;
          const deadline=Date.now()+Math.min(step.timeoutMs||5000,15000);
          do {
            verified=await check(step.expect);
            if(verified || state.status==='paused')break;
            await new Promise(resolve=>setTimeout(resolve,300));
          }while(Date.now()<deadline);
          if(!verified){
            if(state.status!=='paused')state.status='needs_review';
            state.reason='Command sent; expected result has not been verified';this.save();return state;
          }
        }catch(error){state.status='needs_review';state.reason=error.message;this.save();return state;}
      }
      state.uncertain=false;
      state.history.push({index:state.index,command:step.command,verified:true,at:new Date().toISOString()});
      state.index++;state.status=state.index===state.steps.length?'complete':state.status==='paused'?'paused':'ready';
      this.save();return state;
    }finally{this.running=false;}
  }
}
