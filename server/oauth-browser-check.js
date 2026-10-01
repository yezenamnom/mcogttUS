// Isolated synthetic browser regression. Never uses an existing browser profile,
// a real credential or a real ChatGPT callback: callback traffic is intercepted.
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createOwnerOAuth} from './oauth.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let oauth,browser;
const server=http.createServer(async(req,res)=>{
 if(process.argv.includes('--expect-blocked')){
  // Reproduce the former CSP only in this synthetic test server.
  const original=res.writeHead.bind(res);
  res.writeHead=(status,headers)=>{
   if(headers?.['content-security-policy'])headers['content-security-policy']=headers['content-security-policy'].replace(/form-action [^;]+;/,"form-action 'self';");
   return original(status,headers);
  };
 }
 if(!await oauth.handle(req,res,new URL(req.url,issuer))){res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const issuer=`http://127.0.0.1:${server.address().port}`;
const secret='synthetic-browser-test-only';
oauth=createOwnerOAuth({secret,issuer});
try{
 console.log('Launching isolated headless Chromium for synthetic regression.');
 browser=await chromium.launch({headless:true,timeout:60000,...(process.env.TEST_CHROMIUM_PATH?{executablePath:process.env.TEST_CHROMIUM_PATH}:{})});
 const context=await browser.newContext();
 let callback,blocked=false;
 const page=await context.newPage();
 // Playwright route() may skip subsequent URLs in an HTTP redirect chain.
 // CDP Fetch interception runs on each hop, before any external request is sent.
 const cdp=await context.newCDPSession(page);
 await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
 cdp.on('Fetch.requestPaused',async event=>{
  const target=new URL(event.request.url);
  if(target.origin===issuer){await cdp.send('Fetch.continueRequest',{requestId:event.requestId});return;}
  if(target.origin==='https://chatgpt.com'&&target.pathname==='/connector_platform_oauth_redirect')callback=target;
  await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<h1>Synthetic callback received</h1>').toString('base64')});
 });
 page.setDefaultTimeout(10000);
 page.on('console',msg=>{if(msg.text().includes('form-action'))blocked=true;});
 const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
 const client=await (await fetch(issuer+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[redirect]})})).json();
 const verifier=crypto.randomBytes(32).toString('base64url');
 const args={client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),resource:issuer+'/mcp',state:'synthetic-browser-state'};
 await page.goto(issuer+'/oauth/authorize?'+new URLSearchParams(args));
 await page.locator('input[name="owner_token"]').fill(secret);
 const navigation=page.waitForURL('https://chatgpt.com/**',{timeout:5000}).catch(()=>null);
 await page.locator('button[value="allow"]').click();
 await navigation;
 if(process.argv.includes('--expect-blocked')){
  assert.equal(callback,undefined);assert.ok(blocked,'expected a browser CSP form-action violation');
  console.log('REPRODUCED: Chromium blocks the 303 callback under the old form-action policy.');
 }else{
  assert.ok(callback,'callback navigation did not arrive');assert.equal(blocked,false);
  assert.equal(callback.searchParams.get('state'),args.state);assert.equal(callback.searchParams.get('iss'),issuer);
  const response=await fetch(issuer+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:callback.searchParams.get('code'),client_id:client.client_id,redirect_uri:redirect,resource:issuer+'/mcp',code_verifier:verifier})});
  assert.equal(response.status,200);
  const token=await response.json();assert.ok(oauth.accepts('Bearer '+token.access_token));
  console.log('PASS: Chromium form -> 303 -> intercepted callback -> PKCE token exchange.');
 }
}finally{
 await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
