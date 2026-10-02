import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

export const requiredSections=['Identity','Connection','Capabilities','Target','Voice','Execution','Verification','Recovery','Vision','Controls','Examples','Safety'];
export function validateInstructions(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>128*1024||text.includes('\0'))throw Error('Expected UTF-8 Markdown, maximum 128 KB');
 if(!/^# GPT US Instructions\r?$/m.test(text))throw Error('Missing GPT US Instructions title');
 if(!/^Version: \d+\.\d+\.\d+\r?$/m.test(text))throw Error('Missing semantic Version: x.y.z');
 const date=text.match(/^Updated: (\d{4}-\d{2}-\d{2})\r?$/m)?.[1];
 if(!date||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('Invalid Updated: YYYY-MM-DD');
 for(const section of requiredSections)if(!new RegExp('^## '+section+'(?: —[^\\r\\n]*)?\\r?$','m').test(text))throw Error('Missing section: '+section);
 return {version:text.match(/^Version: (\S+)/m)[1],updated:date,sha256:createHash('sha256').update(text).digest('hex')};
}
export class Instructions {
 constructor(defaultPath,path){this.defaultPath=defaultPath;this.path=path;this.defaults=readFileSync(defaultPath,'utf8');validateInstructions(this.defaults);this.current=existsSync(path)?readFileSync(path,'utf8'):this.defaults;validateInstructions(this.current);}
 get(){return {text:this.current,...validateInstructions(this.current)};}
 update(text,expectedHash){
  const metadata=validateInstructions(text);
  if(expectedHash!==this.get().sha256)throw Error('Instructions changed; reload before saving');
  mkdirSync(dirname(this.path),{recursive:true});const backupDir=join(dirname(this.path),'instruction-backups');mkdirSync(backupDir,{recursive:true});
  const backup=join(backupDir,Date.now()+'-'+this.get().sha256.slice(0,12)+'.md');
  writeFileSync(backup,this.current,{flag:'wx'});writeFileSync(this.path+'.tmp',text);renameSync(this.path+'.tmp',this.path);this.current=text;
  return {...metadata,text,backup,applied:true,clientRefreshRequired:true};
 }
 reset(hash){return this.update(this.defaults,hash);}
}
