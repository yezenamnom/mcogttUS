// A bounded read-only visit; never submits forms or invents a business goal.
export function tourLinks(page){
 const origin=new URL(page.url).origin,seen=new Set();
 return (page.links||[]).filter(link=>{try{const u=new URL(link.url);if(u.origin!==origin||u.search||u.hash||u.href===page.url||seen.has(u.href))return false;if(/logout|signout|delete|remove|checkout|purchase|billing|login|signin|admin|حذف|شراء|خروج/i.test(u.pathname+' '+link.text))return false;if(!/^\/(about|help|docs|documentation|features|products|services|faq|learn|guides|support|company)(\/|$)/i.test(u.pathname))return false;seen.add(u.href);return true;}catch{return false;}}).slice(0,2);
}
export async function guidedTour({observe,navigate,scroll,save,maxPages=3}){
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>3)throw Error('maxPages must be 1–3');
 let state={status:'running',pages:[],steps:[],startedAt:new Date().toISOString(),instruction:'Read the observed pages, finish this bounded tour, then give a brief findings summary. No generic clarification question.'};await save(state);
 try{const first=await observe();if(!first.text?.trim())throw Error('OBSERVATION_UNAVAILABLE: no readable page content');const links=tourLinks(first).slice(0,maxPages-1);const urls=[first.url,...links.map(l=>l.url)];
  for(const url of urls){if(state.pages.length){await navigate(url);state.steps.push({action:'navigate',url});}const page=await observe();if(new URL(page.url).origin!==new URL(first.url).origin)throw Error('UNEXPECTED_REDIRECT: stop without further navigation');if(!page.text?.trim())throw Error('OBSERVATION_UNAVAILABLE');if(state.pages.length&&new URL(page.url).pathname!==new URL(url).pathname)throw Error('NAVIGATION_NOT_VERIFIED');state.pages.push(page);await scroll();const after=await observe();state.steps.push({action:'read_and_scroll',url:page.url,verified:after.url===page.url,beforeY:page.scrollY,afterY:after.scrollY});if(after.url!==page.url)throw Error('TARGET_CHANGED');await save(state);}
  state.status='complete';state.completedAt=new Date().toISOString();state.finalUrl=state.pages.at(-1).url;state.scope='Homepage read, scroll and up to two clearly informational same-site pages; not an exhaustive site audit.';await save(state);return state;
 }catch(error){state.status='blocked';state.reason=error.message;await save(state);return state;}
}
