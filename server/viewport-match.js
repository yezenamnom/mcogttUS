// Match distinctive pixel landmarks; ambiguous/occluded views fail closed.
export function locateViewport(desktop, page) {
 const {data:d,width:dw,height:dh}=desktop,{data:p,width:pw,height:ph}=page;
 if(pw>dw||ph>dh||dw*dh>20000000)throw new Error('Unsupported capture dimensions');
 const marks=[];
 for(let y=10;y<ph-10;y+=13)for(let x=10;x<pw-10;x+=13){
  const i=(y*pw+x)*3,j=i+3;
  const contrast=Math.abs(p[i]-p[j])+Math.abs(p[i+1]-p[j+1])+Math.abs(p[i+2]-p[j+2]);
  if(contrast>60)marks.push({x,y,i,contrast});
 }
 marks.sort((a,b)=>b.contrast-a.contrast);
 const chosen=[];
 for(const m of marks)if(chosen.every(n=>Math.hypot(n.x-m.x,n.y-m.y)>40)){chosen.push(m);if(chosen.length===24)break;}
 if(chosen.length<12)throw new Error('Insufficient distinct visual landmarks');
 const matches=[];
 for(let y=0;y<=dh-ph;y++)for(let x=0;x<=dw-pw;x++){
  let valid=true;
  for(const m of chosen){const i=((y+m.y)*dw+x+m.x)*3;
   if(Math.abs(d[i]-p[m.i])+Math.abs(d[i+1]-p[m.i+1])+Math.abs(d[i+2]-p[m.i+2])>24){valid=false;break;}
  }
  if(valid){matches.push({x,y});if(matches.length>1)throw new Error('Ambiguous viewport match');}
 }
 if(matches.length!==1)throw new Error('Visible viewport not found; foreground it and retry');
 return {...matches[0],landmarks:chosen.length};
}
