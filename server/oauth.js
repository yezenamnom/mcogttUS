import crypto from 'node:crypto';

// Single-owner OAuth. Browser approval is intentionally manual, not auto-granted.
export function createOwnerOAuth({secret,issuer,now=()=>Date.now()}) {
 issuer=issuer.replace(/\/$/,''); const resource=issuer+'/mcp';
 const requests=new Map(),codes=new Map(); let attempts=[];
 const random=()=>crypto.randomBytes(32).toString('base64url');
 const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
 const mac=s=>crypto.createHmac('sha256',secret).update('gptus-oauth-v1:'+s).digest('base64url');
 const seal=(type,p)=>{const b=Buffer.from(JSON.stringify({type,...p})).toString('base64url');return b+'.'+mac(b);};
 const open=(s,type)=>{if(typeof s!=='string'||s.length>8192)throw Error('invalid_token');const [b,sig,...extra]=s.split('.');if(extra.length||!sig||!same(sig,mac(b)))throw Error('invalid_token');const p=JSON.parse(Buffer.from(b,'base64url'));if(p.type!==type||(p.exp&&p.exp<=now()))throw Error('invalid_token');return p;};
 const redirectAllowed=s=>{try{const u=new URL(s);return u.origin==='https://chatgpt.com'&&!u.search&&!u.hash&&(u.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname));}catch{return false;}};
 const json=(res,status,v)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v));};
 const body=async req=>{let data='';for await(const b of req){data+=b;if(data.length>16384)throw Error('request_too_large');}return req.headers['content-type']?.startsWith('application/json')?JSON.parse(data):Object.fromEntries(new URLSearchParams(data));};
 const prune=()=>{for(const m of [requests,codes])for(const [k,v]of m)if(v.exp<=now())m.delete(k);};
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const challenge=`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="computer:control"`;
 return {
  challenge,
  accepts(header){if(!secret)return false;const raw=String(header||'');if(same(raw,'Bearer '+secret))return true;try{const p=open(raw.replace(/^Bearer /,''),'access');return raw.startsWith('Bearer ')&&p.iss===issuer&&p.aud===resource&&p.scope==='computer:control'&&!!p.exp;}catch{return false;}},
  async handle(req,res,url){
   const path=url.pathname;
   if(!['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server','/oauth/register','/oauth/authorize','/oauth/approve','/oauth/token'].includes(path))return false;
   if(!secret){json(res,503,{error:'authorization_unavailable'});return true;}
   prune();
   try{
    if(path.startsWith('/.well-known/oauth-protected-resource')&&req.method==='GET'){
     json(res,200,{resource,authorization_servers:[issuer],scopes_supported:['computer:control'],bearer_methods_supported:['header']});return true;
    }
    if(path==='/.well-known/oauth-authorization-server'&&req.method==='GET'){
     json(res,200,{issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',registration_endpoint:issuer+'/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['computer:control'],authorization_response_iss_parameter_supported:true});return true;
    }
    if(path==='/oauth/register'&&req.method==='POST'){
     const b=await body(req);
     if(!Array.isArray(b.redirect_uris)||b.redirect_uris.length<1||b.redirect_uris.length>4||!b.redirect_uris.every(redirectAllowed)||b.token_endpoint_auth_method&&b.token_endpoint_auth_method!=='none')throw Error('invalid_client_metadata');
     json(res,201,{client_id:seal('client',{redirects:b.redirect_uris,nonce:random()}),redirect_uris:b.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code'],scope:'computer:control'});return true;
    }
    if(path==='/oauth/authorize'&&req.method==='GET'){
     const b=Object.fromEntries(url.searchParams),client=open(b.client_id,'client');
     if(!client.redirects.includes(b.redirect_uri)||!redirectAllowed(b.redirect_uri)||b.response_type!=='code'||b.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(b.code_challenge||'')||b.resource!==resource||b.scope&&b.scope!=='computer:control'||!b.state||b.state.length>2048)throw Error('invalid_request');
     if(requests.size>=200)throw Error('temporarily_unavailable');
     const id=random(),csrf=random();requests.set(id,{...b,csrf,exp:now()+300000});
     res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'set-cookie':`gptus_oauth=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=300`});
     res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ربط GPT US</title><style>body{font:18px system-ui;max-width:650px;margin:60px auto;padding:24px;background:#101824;color:#e7f3ff}input,button{font:inherit;padding:12px;margin:10px 0;max-width:100%;box-sizing:border-box}input{width:100%}</style><h1>موافقة صاحب الكمبيوتر</h1><p>هذا الربط يمنح ChatGPT أدوات قراءة الشاشة والتحكم بالماوس والملفات، ضمن صلاحيات برنامج Windows. لا توافق على طلب لم تبدأه بنفسك.</p><p>وجهة الرجوع: ${esc(b.redirect_uri)}</p><form method="post" action="/oauth/approve"><input type="hidden" name="request" value="${id}"><label>أدخل Bridge token من برنامجك بنفسك<input name="owner_token" type="password" required autocomplete="off"></label><button name="decision" value="allow">أوافق على ربط جهازي لمدة ساعة</button><button name="decision" value="deny" formnovalidate>رفض</button></form><p>لا ترسل الرمز في المحادثة. لا يتم وضعه في رابط الرجوع أو إرساله إلى ChatGPT.</p></html>`);return true;
    }
    if(path==='/oauth/approve'&&req.method==='POST'){
     if(req.headers.origin!==issuer)throw Error('invalid_origin');
     const b=await body(req),pending=requests.get(b.request);
     const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('gptus_oauth='))?.slice(12);
     if(!pending||!cookie||!same(cookie,pending.csrf))throw Error('invalid_request');
     const redirect=new URL(pending.redirect_uri);redirect.searchParams.set('state',pending.state);redirect.searchParams.set('iss',issuer);
     if(b.decision==='deny'){requests.delete(b.request);redirect.searchParams.set('error','access_denied');}
     else {
      attempts=attempts.filter(t=>t>now()-60000);if(attempts.length>=10){json(res,429,{error:'rate_limited'});return true;}attempts.push(now());
      if(b.decision!=='allow'||!same(b.owner_token||'',secret)){json(res,403,{error:'approval_denied'});return true;}
      requests.delete(b.request);const code=random();codes.set(code,{...pending,exp:now()+120000});redirect.searchParams.set('code',code);
     }
     res.writeHead(303,{location:redirect.toString(),'cache-control':'no-store','set-cookie':'gptus_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=0'});res.end();return true;
    }
    if(path==='/oauth/token'&&req.method==='POST'){
     const b=await body(req),c=codes.get(b.code);codes.delete(b.code);
     if(!c||b.grant_type!=='authorization_code'||b.client_id!==c.client_id||b.redirect_uri!==c.redirect_uri||b.resource!==resource||!/^[A-Za-z0-9._~-]{43,128}$/.test(b.code_verifier||'')||!same(crypto.createHash('sha256').update(b.code_verifier).digest('base64url'),c.code_challenge))throw Error('invalid_grant');
     json(res,200,{access_token:seal('access',{iss:issuer,aud:resource,scope:'computer:control',client_id:c.client_id,exp:now()+3600000,nonce:random()}),token_type:'Bearer',expires_in:3600,scope:'computer:control'});return true;
    }
    json(res,405,{error:'method_not_allowed'});return true;
   }catch{json(res,400,{error:'invalid_request'});return true;}
  }
 };
}
