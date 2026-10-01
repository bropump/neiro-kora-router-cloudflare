import {endpoint,bodyJSON,json,MAX_OPERATORS} from './policy.mjs';
import {inspect,ownership,upstream} from './upstream.mjs';
import {selectOperator,normalizePrice} from './selection.mjs';
import {loadRegional,noteQuote,refreshRegional} from './regional.mjs';
import {probeQuote,transactionPayer} from './probe.mjs';
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function budget(env,key,max){
 const now=Date.now();const result=await env.DB.prepare('INSERT INTO limits (id,n,reset) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET n=CASE WHEN reset<=? THEN 1 ELSE n+1 END, reset=CASE WHEN reset<=? THEN ? ELSE reset END WHERE reset<=? OR n<? RETURNING n').bind(key,now+3600000,now,now,now+3600000,now,max).first();return !!result;
}
async function save(env,row){await env.DB.prepare('UPDATE operators SET status=?,checked_at=?,data=? WHERE id=?').bind(row.status,row.checkedAt,JSON.stringify(row),row.id).run();}
function configuredOperators(env){
 const entries=JSON.parse(env.CONFIGURED_OPERATORS||'[]');
 if(!Array.isArray(entries)||entries.length>MAX_OPERATORS)throw Error('Invalid configured operators');
 return entries.map(x=>{
  if(!x||typeof x.payer!=='string'||typeof x.paymentAddress!=='string'||![x.payer,x.paymentAddress].every(v=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)))throw Error('Invalid configured identity');
  return {url:endpoint(x.url,(env.ROUTER_HOSTS||'').split(',')),payer:x.payer,paymentAddress:x.paymentAddress};
 });
}
async function check(env,row,identityOnly=false){try{
 const configured=configuredOperators(env).find(x=>x.url===row.url);
 if(!configured&&!await ownership(row)){row.status='disabled';row.checkedAt=Date.now();row.verifiedAt=Date.now();await save(env,row);return;}
 if(identityOnly&&row.payer&&row.paymentAddress&&row.verifiedAt&&row.status!=='disabled'){
  const identity=(await upstream(row.url,'getPayerSigner')).value.result;
  if(identity?.signer_address!==row.payer||identity.payment_address!==row.paymentAddress)throw Error('Operator identity changed');
  row.verifiedAt=Date.now();await save(env,row);return;
 }
 const measured=await inspect(row.url,env.NEIRO_MINT);
 if(configured&&(measured.payer!==configured.payer||measured.paymentAddress!==configured.paymentAddress))throw Error('Configured operator identity changed');
 Object.assign(row,measured,{status:'active',verifiedAt:Date.now()});await save(env,row);
 }catch(e){if(row.status!=='pending')row.status='disabled';row.checkedAt=Date.now();row.verifiedAt=Date.now();await save(env,row);throw e;}}
async function enroll(action,input,ip,env){
 if(!await budget(env,'ip:'+await hash(ip),6)||!await budget(env,'global',60))return json({error:'Registration limit reached; try later'},429);
 if(action==='register'){
 const url=endpoint(input.url,(env.ROUTER_HOSTS||'').split(',')),id=(await hash(url)).slice(0,32);
 await env.DB.prepare("DELETE FROM operators WHERE status='pending' AND created_at<?").bind(Date.now()-900000).run();
 let stored=await env.DB.prepare('SELECT data FROM operators WHERE id=?').bind(id).first();
 if(!stored){const row={id,url,token:crypto.randomUUID()+crypto.randomUUID(),status:'pending',createdAt:Date.now(),checkedAt:0};
 const result=await env.DB.prepare('INSERT OR IGNORE INTO operators (id,host,status,created_at,checked_at,last_attempt,data) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM operators)<?').bind(id,new URL(url).hostname,'pending',row.createdAt,0,0,JSON.stringify(row),MAX_OPERATORS).run();
 stored=await env.DB.prepare('SELECT data FROM operators WHERE id=?').bind(id).first();if(!stored)return json({error:'Hostname already enrolled or enrollment capacity reached'},409);}
 const row=JSON.parse(stored.data);return json({id:row.id,status:row.status,verificationUrl:new URL('/.well-known/neiro-router/'+id,url).href,verification:{token:row.token,enabled:true},next:'Serve this JSON at verificationUrl, then POST /operators/verify with id. Keep the file available; no wallet signature or daily renewal.'});
 }
 if(action==='verify'){
 if(typeof input.id!=='string'||!/^[a-f0-9]{32}$/.test(input.id))return json({error:'Invalid registration ID'},400);
 const now=Date.now();const stored=await env.DB.prepare('UPDATE operators SET last_attempt=? WHERE id=? AND last_attempt<? RETURNING data').bind(now,input.id,now-60000).first();
 if(!stored)return json({error:'Unknown registration or verification cooldown'},429);
 const row=JSON.parse(stored.data);try{await check(env,row);return json({id:row.id,status:row.status});}catch{return json({id:row.id,status:row.status,error:'Verification or Kora health failed'},422);}
 }
 return json({error:'Not found'},404);
}
async function maintain(env){
 const now=Date.now();
 // Deployment-owned public endpoints are trusted admission configuration, not
 // a flag accepted through registration. Identity is rechecked on every refresh.
 for(const entry of configuredOperators(env)){
  const id=(await hash(entry.url)).slice(0,32),row={...entry,id,status:'offline',token:'',createdAt:now,checkedAt:0,healthy:false};
  await env.DB.prepare(`INSERT INTO operators(id,host,status,created_at,checked_at,last_attempt,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='offline',checked_at=0,data=json_set(operators.data,'$.status','offline','$.checkedAt',0) WHERE operators.status='pending'`).bind(id,new URL(entry.url).hostname,'offline',now,0,0,JSON.stringify(row)).run();
 }
await env.DB.batch([env.DB.prepare("DELETE FROM operators WHERE status='pending' AND created_at<?").bind(now-900000),env.DB.prepare('DELETE FROM limits WHERE reset<?').bind(now)]);
 const rows=await env.DB.prepare("SELECT id FROM operators WHERE status!='pending' AND COALESCE(json_extract(data,'$.verifiedAt'),0)<? ORDER BY checked_at ASC LIMIT 100").bind(now-600000).all();
 for(let i=0;i<rows.results.length;i+=4)await Promise.all(rows.results.slice(i,i+4).map(async({id})=>{
 const stored=await env.DB.prepare('UPDATE operators SET last_attempt=? WHERE id=? AND last_attempt<? RETURNING data').bind(now,id,now-60000).first();if(stored)await check(env,JSON.parse(stored.data),true).catch(()=>{});
 }));
}
async function recordConfig(env,origin,row,event){
 const status=event.ok?'active':'offline';
 // Atomic predicate prevents a concurrent identity/ownership rejection from
 // being overwritten by a configuration-only health success.
 await env.DB.prepare(`UPDATE operators SET status=?,checked_at=?,data=json_set(data,
 '$.status',?,'$.healthy',json(?),'$.checkedAt',?,'$.price',
 CASE WHEN ? THEN json(?) ELSE json_extract(data,'$.price') END)
 WHERE id=? AND status IN ('active','offline')`)
 .bind(status,event.at,status,event.ok?'true':'false',event.at,event.ok?1:0,JSON.stringify(event.config?.validation_config?.price??null),row.id).run();
 await caches.default.delete(new Request(origin+'/_pool'));
}
const refresh=(rows,env,origin,region)=>refreshRegional(rows,env,origin,region,row=>probeQuote(row,env.NEIRO_MINT),{onConfig:(row,event)=>recordConfig(env,origin,row,event)});
async function scheduledRefresh(env){
 await maintainIfDue(env);
 const origin='https://'+(env.ROUTER_HOSTS||'router.invalid').split(',')[0];
 const stored=await env.DB.prepare("SELECT data FROM operators WHERE status IN ('active','offline') LIMIT 100").all();
 await refresh(stored.results.map(x=>JSON.parse(x.data)),env,origin,'SCHEDULED');
}
async function maintainIfDue(env){
 const now=Date.now();
 const lease=await env.DB.prepare(`INSERT INTO regional_leases(id,n,reset) VALUES ('directory-maintenance',1,?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id`).bind(now+60000,now).first();
 if(lease)await maintain(env);
}
async function pool(env,ctx,origin){
 const key=new Request(origin+'/_pool');let cached=await caches.default.match(key);if(cached)return (await cached.json()).rows;
 const result=await env.DB.prepare("SELECT data FROM operators WHERE status='active' AND checked_at>? LIMIT 100").bind(Date.now()-300000).all();const value={rows:result.results.map(r=>{const {token,...row}=JSON.parse(r.data);return row;})};await caches.default.put(key,Response.json(value,{headers:{'cache-control':'max-age=15'}}));return value.rows;
}
function regionalCandidates(rows,region){
 const now=Date.now();return rows.map(row=>{
  const c=row.configStats,fresh=c?.region===region&&Number.isSafeInteger(c.at)&&c.at<=now&&now-c.at<300000;
  return {...row,healthy:row.healthy&&row.failedUntil<=now&&!(fresh&&c.failed),
   latencyMs:fresh&&Number.isFinite(c.latencyMs)&&c.latencyMs>=0?c.latencyMs:1e9,
   price:row.price};
 });
}
export default {async scheduled(controller,env,ctx){ctx.waitUntil(scheduledRefresh(env));},async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'86400'}});
 if(url.pathname==='/healthz')return json({ok:true,mode:'url-enrollment',colo:request.cf?.colo||'unknown'});
 if(!(await env.REQUEST_LIMIT.limit({key:request.headers.get('cf-connecting-ip')||'unknown'})).success)return json({error:'Request limit reached'},429);
 if(url.pathname==='/operators/register'||url.pathname==='/operators/verify'){
  if(env.ENROLLMENT_OPEN!=='true')return json({error:'Enrollment closed'},503);
  if(request.method!=='POST')return json({error:'POST required'},405);
  try{const value=await bodyJSON(request);return await enroll(url.pathname.split('/').at(-1),value,request.headers.get('cf-connecting-ip')||'unknown',env);}catch{return json({error:'Invalid request'},400);}
 }
 if(['/operators','/rpc'].includes(url.pathname))ctx.waitUntil(maintainIfDue(env).catch(()=>{}));
 if(url.pathname==='/operators'&&request.method==='GET'){
  try{const region=request.cf?.colo||'unknown',baseRows=await pool(env,ctx,url.origin);
   ctx.waitUntil(refresh(baseRows,env,url.origin,region).catch(()=>{}));
   const rows=regionalCandidates(await loadRegional(baseRows,env,url.origin,region),region);
   return json({colo:region,operators:rows.map(r=>({id:r.id,payer:r.payer,eligible:!!r.healthy,latencyMs:r.latencyMs===1e9?null:r.latencyMs,price:normalizePrice(r.price),quoteEwmaMs:r.quoteStats?.region===region&&r.quoteStats.at<=Date.now()&&Date.now()-r.quoteStats.at<300000?r.quoteStats.ewmaMs:null,checkedAt:r.checkedAt,sampleQuote:r.sampleQuote?{...r.sampleQuote,stale:Date.now()-r.sampleQuote.at>660000}:null}))});
  }catch{return json({error:'Directory unavailable'},503);}
 }
 if(url.pathname!=='/rpc')return json({error:'Not found'},404);
 if(request.method!=='POST')return json({error:'POST required'},405);
 let id=null,chosen,region=request.cf?.colo||'unknown',isQuote=false;try{
  if(request.headers.has('x-neiro-router-hop'))return json({error:'Routing loop'},400);
  const body=await bodyJSON(request,65536);id=body.id??null;
  const allowed=['getConfig','getPayerSigner','getSupportedTokens','getBlockhash','estimateTransactionFee','signAndSendTransaction'];
  if(body.params===undefined||(Array.isArray(body.params)&&body.params.length===0))body.params={};
  if(body.jsonrpc!=='2.0'||!allowed.includes(body.method)||!body.params||typeof body.params!=='object'||Array.isArray(body.params))return json({error:'Unsupported request'},400);
  if(body.method==='signAndSendTransaction'&&env.ENABLE_SUBMISSIONS!=='true')return json({error:'Submissions disabled on test deployment'},403);
  const baseRows=await pool(env,ctx,url.origin);
  // Refresh/probes never block forwarding. D1 leases bound work across isolates.
  ctx.waitUntil(refresh(baseRows,env,url.origin,region).catch(()=>{}));
  const rows=regionalCandidates(await loadRegional(baseRows,env,url.origin,region),region);
  const queryPayer=url.searchParams.get('provider')||undefined,paramPayer=body.params.signer_key;
  const transactionMethod=['estimateTransactionFee','signAndSendTransaction'].includes(body.method);
  const wirePayer=transactionMethod?transactionPayer(body.params.transaction):undefined;
  const pins=[queryPayer,paramPayer,wirePayer].filter(x=>x!==undefined);
  if(new Set(pins).size>1)return json({jsonrpc:'2.0',id,error:{code:-32602,message:'Conflicting provider or transaction payer'}},400);
  const mode=url.searchParams.get('selection')||'fastest',priceGroup=url.searchParams.get('priceGroup')||undefined;
  chosen=selectOperator(rows,{mode,payer:pins[0],operatorId:url.searchParams.get('operator')||undefined,priceGroup,region});
  isQuote=body.method==='estimateTransactionFee';
  const result=await upstream(chosen.url,body.method,{...body.params,signer_key:chosen.payer},body.method==='signAndSendTransaction'?20000:8000);
  if(isQuote){const v=result.value.result,valid=!result.value.error&&v?.signer_pubkey===chosen.payer&&v.payment_address===chosen.paymentAddress&&Number.isSafeInteger(v.fee_in_lamports)&&v.fee_in_lamports>=0&&(!body.params.fee_token||(Number.isSafeInteger(v.fee_in_token)&&v.fee_in_token>=0));
   ctx.waitUntil(noteQuote(chosen,env,url.origin,region,{ok:valid,ms:result.ms,kind:valid?'traffic':result.value.error?'business':'protocol'}).catch(()=>{}));
   if(!result.value.error&&!valid)throw Error('Invalid quote identity or amount');
  }
  const q=chosen.quoteStats,quoteFresh=q?.region===region&&q.at<=Date.now()&&Date.now()-q.at<300000;
  return json({...result.value,id,routing:{provider:chosen.payer,providerId:chosen.id,upstreamMs:result.ms,colo:region,
   selection:pins.length?'pinned':mode==='cheapest'?'lowest comparable advertised rate':'recent regional quote latency with config fallback',
   advertisedPrice:normalizePrice(chosen.price),latencySource:quoteFresh?(q.source==='probe'?'regional-probe-ewma':'regional-quote-ewma'):chosen.latencyMs===1e9?'cold-start':'regional-config',
   quoteEwmaMs:quoteFresh?q.ewmaMs:null,configMs:chosen.latencyMs===1e9?null:chosen.latencyMs}});
 }catch(e){if(chosen&&isQuote)ctx.waitUntil(noteQuote(chosen,env,url.origin,region,{ok:false,kind:'transport'}).catch(()=>{}));const selectionErrors=['Incomparable advertised pricing; specify priceGroup','Invalid selection options','Selected payer is ambiguous; pin operator ID'];return json({jsonrpc:'2.0',id,error:{code:selectionErrors.includes(e.message)?-32602:-32001,message:selectionErrors.includes(e.message)?e.message:'Provider unavailable; submissions are never automatically retried'}},selectionErrors.includes(e.message)?400:503);}
}};
