import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {createOwnerOAuth} from './oauth.js';

// Synthetic requests only: no real account, token or consent automation.
async function fixture(){
 const issuer='https://synthetic.example',secret='synthetic-test-secret';
 let clock=Date.now(),oauth;
 const restart=()=>oauth=createOwnerOAuth({issuer,secret,now:()=>clock});restart();
 async function call(path,method='GET',data={},headers={},json=false){
  const req=Readable.from(method==='POST'?[json?JSON.stringify(data):new URLSearchParams(data).toString()]:[]);
  req.method=method;req.headers={'content-type':json?'application/json':'application/x-www-form-urlencoded',...headers};
  const out={}; const res={writeHead(status,h){out.status=status;out.headers=h},end(body){out.body=body||''}};
  await oauth.handle(req,res,new URL(path,issuer));return out;
 }
 const client=JSON.parse((await call('/oauth/register','POST',{redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']},{},true)).body);
 const verifier='v'.repeat(43);
 const args={client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),resource:issuer+'/mcp',state:'synthetic'};
 async function page(){const r=await call('/oauth/authorize?'+new URLSearchParams(args));assert.equal(r.status,200);return {request:r.body.match(/name="request" value="([^"]+)"/)[1],cookie:r.headers['set-cookie'].split(';')[0]};}
 const approve=(p,headers={},extra={})=>call('/oauth/approve','POST',{request:p.request,decision:'allow',owner_token:secret,...extra},{origin:issuer,cookie:p.cookie,...headers});
 return {call,page,approve,restart,advance:ms=>clock+=ms,issuer,args,verifier};
}

test('parallel consent tabs use independent cookies',async()=>{
 const f=await fixture(),a=await f.page(),b=await f.page();
 assert.notEqual(a.cookie.split('=')[0],b.cookie.split('=')[0]);
 const cookie=a.cookie+'; '+b.cookie;
 assert.equal((await f.approve(a,{cookie})).status,303);
 assert.equal((await f.approve(b,{cookie})).status,303);
});
test('repeated approval explains prior submission and never reissues a code',async()=>{
 const f=await fixture(),p=await f.page();
 assert.equal((await f.approve(p)).status,303);
 const repeated=await f.approve(p,{cookie:''});
 assert.equal(repeated.status,200);
 assert.equal(JSON.parse(repeated.body).status,'already_submitted');
 assert.equal(repeated.headers.location,undefined);
 assert.equal(repeated.body.includes('access_token'),false);
});
test('missing and wrong cookies have distinct diagnostics and fail closed',async()=>{
 const f=await fixture(),p=await f.page();
 let r=await f.approve(p,{cookie:''});
 assert.equal(r.status,400);assert.equal(JSON.parse(r.body).reason,'csrf_cookie_missing');
 r=await f.approve(p,{cookie:p.cookie.split('=')[0]+'=wrong'});
 assert.equal(r.status,400);assert.equal(JSON.parse(r.body).reason,'csrf_mismatch');
 assert.equal((await f.approve(p)).status,303);
});
test('expired or restarted consent returns an actionable explanation',async()=>{
 const f=await fixture();let p=await f.page();f.advance(300001);
 let r=await f.approve(p);assert.equal(r.status,400);assert.equal(JSON.parse(r.body).reason,'request_expired_or_restarted');
 p=await f.page();f.restart();r=await f.approve(p);
 assert.equal(r.status,400);assert.equal(JSON.parse(r.body).reason,'request_expired_or_restarted');
});
test('wrong origin and wrong owner token remain denied',async()=>{
 const f=await fixture(),p=await f.page();
 const r=await f.approve(p,{origin:'null'});
 assert.equal(r.status,400);assert.equal(JSON.parse(r.body).reason,'invalid_origin');
 assert.equal((await f.approve(p,{}, {owner_token:'wrong'})).status,403);
});
test('HTML errors and direct approve URL are understandable and disclose no secrets',async()=>{
 const f=await fixture(),p=await f.page();
 const r=await f.approve(p,{accept:'text/html',cookie:''});
 assert.equal(r.status,400);assert.match(r.headers['content-type'],/text\/html/);
 assert.ok(r.body.includes('csrf_cookie_missing'));
 assert.equal(r.body.includes(p.request),false);assert.equal(r.body.includes(p.cookie),false);
 assert.equal(r.body.includes('synthetic-test-secret'),false);
 const direct=await f.call('/oauth/approve');assert.equal(direct.status,400);
 assert.equal(JSON.parse(direct.body).reason,'request_missing');
});
test('denial cannot accidentally approve and duplicate denial cannot mint a code',async()=>{
 const f=await fixture(),p=await f.page();
 const r=await f.approve(p,{}, {decision:'deny',owner_token:''});
 assert.equal(r.status,303);const callback=new URL(r.headers.location);
 assert.equal(callback.searchParams.get('error'),'access_denied');assert.equal(callback.searchParams.has('code'),false);
 const repeated=await f.approve(p);assert.equal(repeated.status,200);assert.equal(repeated.headers.location,undefined);
});
