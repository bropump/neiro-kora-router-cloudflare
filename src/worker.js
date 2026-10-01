import {endpoint,bodyJSON,bounded,json} from './policy.mjs';
import {inspect,ownership,upstream,forward} from './upstream.mjs';
import {selectOperator,normalizePrice} from './selection.mjs';
import {loadRegional,noteQuote,refreshRegional} from './regional.mjs';
import {probeQuote,transactionPayer} from './probe.mjs';
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function budget(env,key,max){
 const now=Date.now();const result=await env.DB.prepare('INSERT INTO limits (id,n,reset) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET n=CASE WHEN reset<=? THEN 1 ELSE n+1 END, reset=CASE WHEN reset<=? THEN ? ELSE reset END WHERE reset<=? OR n<? RETURNING n').bind(key,now+3600000,now,now,now+3600000,now,max).first();return !!result;
}
function configuredOperators(env){
 const entries=JSON.parse(env.CONFIGURED_OPERATORS||'[]');
 if(!Array.isArray(entries))throw Error('Invalid configured operators');
 return entries.map(x=>{
  if(!x||typeof x.payer!=='string'||typeof x.paymentAddress!=='string'||![x.payer,x.paymentAddress].every(v=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)))throw Error('Invalid configured identity');
  return {url:endpoint(x.url,(env.ROUTER_HOSTS||'').split(',')),payer:x.payer,paymentAddress:x.paymentAddress};
 });
}
async function check(env,row,identityOnly=false,attempt){try{
 const configured=configuredOperators(env).find(x=>x.url===row.url);
 if(!configured&&!await ownership(row)){await removeOperator(env,row.id);row.status='removed';return;}
 if(identityOnly&&row.payer&&row.paymentAddress&&row.verifiedAt&&row.status!=='disabled'){
  const identity=(await upstream(row.url,'getPayerSigner')).value.result;
  if(identity?.signer_address!==row.payer||identity.payment_address!==row.paymentAddress)throw Error('Operator identity changed');
  // Identity inspection owns only verifiedAt; never restore a stale health/status snapshot.
  await env.DB.prepare("UPDATE operators SET data=json_set(data,'$.verifiedAt',?) WHERE id=? AND last_attempt=?").bind(Date.now(),row.id,attempt).run();return;
 }
 const measured=await inspect(row.url,env.NEIRO_MINT);
 if(configured&&(measured.payer!==configured.payer||measured.paymentAddress!==configured.paymentAddress))throw Error('Configured operator identity changed');
 if(row.payer&&(row.payer!==measured.payer||row.paymentAddress!==measured.paymentAddress))throw Error('Operator identity changed; remove and re-register');
 const now=Date.now();
 const updated=await env.DB.prepare(`UPDATE operators SET status='active',checked_at=?,data=json_set(data,
 '$.status','active','$.healthy',json('true'),'$.checkedAt',?,'$.verifiedAt',?,
 '$.identityBoundAt',COALESCE(json_extract(data,'$.identityBoundAt'),CASE WHEN json_extract(data,'$.payer') IS NOT NULL THEN created_at ELSE ? END),
 '$.payer',?,'$.paymentAddress',?,'$.latencyMs',?,'$.price',json(?)) WHERE id=? AND last_attempt=? AND checked_at<=? RETURNING status`)
 .bind(measured.checkedAt,measured.checkedAt,now,now,measured.payer,measured.paymentAddress,measured.latencyMs,JSON.stringify(measured.price??null),row.id,attempt,measured.checkedAt).first();
 if(updated)row.status='active';
 }catch(e){
 const now=Date.now(),status=row.status==='pending'?'pending':'disabled';
 const updated=await env.DB.prepare("UPDATE operators SET status=?,checked_at=?,data=json_set(data,'$.status',?,'$.healthy',json('false'),'$.checkedAt',?,'$.verifiedAt',?) WHERE id=? AND last_attempt=? RETURNING status").bind(status,now,status,now,now,row.id,attempt).first();
 if(updated)row.status=status;throw e;
 }}
async function removeOperator(env,id){
 await env.DB.batch([env.DB.prepare('DELETE FROM operators WHERE id=?').bind(id),env.DB.prepare('DELETE FROM regional_stats WHERE operator_id=?').bind(id),env.DB.prepare('DELETE FROM operator_observations WHERE operator_id=?').bind(id)]);
}
function positiveSetting(env,key,fallback){const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<1)throw Error('Invalid '+key);return n;}
async function enroll(action,input,ip,env){
 if(!await budget(env,'ip:'+await hash(ip),positiveSetting(env,'ADMISSION_REQUESTS_PER_IP_HOUR',60)))return json({error:'Registration limit reached; try later'},429);
 if(action==='register'){
 const url=endpoint(input.url,(env.ROUTER_HOSTS||'').split(',')),id=(await hash(url)).slice(0,32);
 await env.DB.prepare("DELETE FROM operators WHERE status='pending' AND created_at<?").bind(Date.now()-900000).run();
 let stored=await env.DB.prepare('SELECT data FROM operators WHERE id=?').bind(id).first();
 if(!stored){const row={id,url,token:crypto.randomUUID()+crypto.randomUUID(),status:'pending',createdAt:Date.now(),checkedAt:0};
 const result=await env.DB.prepare('INSERT OR IGNORE INTO operators (id,host,status,created_at,checked_at,last_attempt,data) VALUES (?,?,?,?,?,?,?)').bind(id,new URL(url).hostname,'pending',row.createdAt,0,0,JSON.stringify(row)).run();
 stored=await env.DB.prepare('SELECT data FROM operators WHERE id=?').bind(id).first();if(!stored)return json({error:'Registration could not be stored'},409);}
 const row=JSON.parse(stored.data);return json({id:row.id,status:row.status,verificationUrl:new URL('/.well-known/neiro-router/'+id,url).href,verification:{token:row.token,enabled:true},next:'Serve this JSON at verificationUrl, then POST /operators/verify with id. Keep the file available; no wallet signature or daily renewal.'});
 }
 if(action==='remove'){
 if(typeof input.id!=='string'||!/^[a-f0-9]{32}$/.test(input.id))return json({error:'Invalid registration ID'},400);
 const stored=await env.DB.prepare('SELECT data FROM operators WHERE id=?').bind(input.id).first();
 if(!stored)return json({error:'Unknown registration'},404);
 const row=JSON.parse(stored.data);
 if(configuredOperators(env).some(x=>x.url===row.url))return json({error:'Configured operator must be removed from deployment configuration'},409);
 // An ID or public token alone grants no authority: verify the owner-controlled HTTPS proof.
 if(await ownership(row)!==false)return json({error:'Set enabled:false in the ownership proof before removal'},409);
 await removeOperator(env,row.id);return json({id:row.id,status:'removed'});
 }
 if(action==='verify'){
 if(typeof input.id!=='string'||!/^[a-f0-9]{32}$/.test(input.id))return json({error:'Invalid registration ID'},400);
 const now=Date.now();const stored=await env.DB.prepare('UPDATE operators SET last_attempt=? WHERE id=? AND last_attempt<? RETURNING data').bind(now,input.id,now-60000).first();
 if(!stored)return json({error:'Unknown registration or verification cooldown'},429);
 const row=JSON.parse(stored.data);try{await check(env,row,false,now);return json({id:row.id,status:row.status});}catch{return json({id:row.id,status:row.status,error:'Verification or Kora health failed'},422);}
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
 const rows=await env.DB.prepare("SELECT id FROM operators WHERE status!='pending' AND COALESCE(json_extract(data,'$.verifiedAt'),0)<? ORDER BY COALESCE(json_extract(data,'$.verifiedAt'),0),id LIMIT ?").bind(now-600000,positiveSetting(env,'MAINTENANCE_BATCH_SIZE',100)).all();
 for(let i=0;i<rows.results.length;i+=4)await Promise.all(rows.results.slice(i,i+4).map(async({id})=>{
 const stored=await env.DB.prepare('UPDATE operators SET last_attempt=? WHERE id=? AND last_attempt<? RETURNING data').bind(now,id,now-60000).first();if(stored)await check(env,JSON.parse(stored.data),true,now).catch(()=>{});
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
const refresh=(rows,env,origin,region)=>refreshRegional(rows.filter(row=>['active','offline'].includes(row.status)),env,origin,region,row=>probeQuote(row,env.NEIRO_MINT),{onConfig:(row,event)=>recordConfig(env,origin,row,event)});
async function scheduledRefresh(env){
 await maintainIfDue(env);
 const origin='https://'+(env.ROUTER_HOSTS||'router.invalid').split(',')[0];
 const stored=await env.DB.prepare("SELECT data FROM operators WHERE status IN ('active','offline')").all();
 await refresh(stored.results.map(x=>JSON.parse(x.data)),env,origin,'SCHEDULED');
}
async function maintainIfDue(env){
 const now=Date.now();
 const lease=await env.DB.prepare(`INSERT INTO regional_leases(id,n,reset) VALUES ('directory-maintenance',1,?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id`).bind(now+60000,now).first();
 if(lease)await maintain(env);
}
async function pool(env,ctx,origin){
 const key=new Request(origin+'/_pool'),fallbackKey=new Request(origin+'/_pool-fallback');
 const configured=new Set(configuredOperators(env).map(row=>row.url));
 const fresh=rows=>rows.map(row=>({...row,configured:configured.has(row.url),healthy:row.status==='active'&&row.healthy===true&&row.checkedAt>Date.now()-300000}));
 const cached=await caches.default.match(key);if(cached)return fresh((await cached.json()).rows);
 try{
 const result=await env.DB.prepare("SELECT data FROM operators WHERE status!='pending' AND json_extract(data,'$.payer') IS NOT NULL").all();
 const value={rows:result.results.map(r=>{const {token,...row}=JSON.parse(r.data);return row;})};
 await Promise.all([caches.default.put(key,Response.json(value,{headers:{'cache-control':'max-age=15'}})),caches.default.put(fallbackKey,Response.json(value,{headers:{'cache-control':'max-age=300'}}))]);return fresh(value.rows);
 }catch(error){const fallback=await caches.default.match(fallbackKey);if(!fallback)throw error;return fresh((await fallback.json()).rows);}
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
 if(['/operators/register','/operators/verify','/operators/remove'].includes(url.pathname)){
  if(url.pathname!=='/operators/remove'&&env.ENROLLMENT_OPEN!=='true')return json({error:'Enrollment closed'},503);
  if(request.method!=='POST')return json({error:'POST required'},405);
  try{const value=await bodyJSON(request);const result=await enroll(url.pathname.split('/').at(-1),value,request.headers.get('cf-connecting-ip')||'unknown',env);if(url.pathname!=='/operators/register')await Promise.all(['/_pool','/_pool-fallback'].map(path=>caches.default.delete(new Request(url.origin+path))));return result;}catch{return json({error:'Invalid request'},400);}
 }
 if(['/operators','/rpc'].includes(url.pathname))ctx.waitUntil(maintainIfDue(env).catch(()=>{}));
 if(url.pathname==='/operators'&&request.method==='GET'){
  try{const region=request.cf?.colo||'unknown',baseRows=await pool(env,ctx,url.origin);
   ctx.waitUntil(refresh(baseRows,env,url.origin,region).catch(()=>{}));
   const rows=regionalCandidates(await loadRegional(baseRows,env,url.origin,region,ctx),region);
   return json({colo:region,operators:rows.map(r=>({id:r.id,payer:r.payer,eligible:!!r.healthy,latencyMs:r.latencyMs===1e9?null:r.latencyMs,price:normalizePrice(r.price),quoteEwmaMs:r.quoteStats?.region===region&&r.quoteStats.at<=Date.now()&&Date.now()-r.quoteStats.at<300000?r.quoteStats.ewmaMs:null,checkedAt:r.checkedAt,sampleQuote:r.sampleQuote?{...r.sampleQuote,stale:Date.now()-r.sampleQuote.at>660000}:null}))});
  }catch{return json({error:'Directory unavailable'},503);}
 }
 if(url.pathname!=='/rpc')return json({error:'Not found'},404);
 if(request.method!=='POST')return json({error:'POST required'},405);
 let id=null,chosen,region=request.cf?.colo||'unknown',isQuote=false;try{
  if(request.headers.has('x-neiro-router-hop'))return json({error:'Routing loop'},400);
  const raw=await bounded(request,positiveSetting(env,'MAX_RPC_BODY_BYTES',1048576));
  const body=JSON.parse(raw),batch=Array.isArray(body),calls=batch?body:[body];
  if(!calls.length||calls.some(call=>!call||call.jsonrpc!=='2.0'||typeof call.method!=='string'))return json({error:'Invalid JSON-RPC request'},400);
  id=batch?null:body.id??null;
  const baseRows=await pool(env,ctx,url.origin);
  ctx.waitUntil(refresh(baseRows,env,url.origin,region).catch(()=>{}));
  const rows=regionalCandidates(await loadRegional(baseRows,env,url.origin,region,ctx),region);
  const queryPayer=url.searchParams.get('provider')||undefined,operatorId=url.searchParams.get('operator')||undefined;
  const pins=[queryPayer];let unknownTransaction=false;
  for(const call of calls){
   const params=call.params;
   if(params&&typeof params==='object'&&!Array.isArray(params)){
    if(params.signer_key!==undefined)pins.push(params.signer_key);
    for(const transaction of [params.transaction,...(Array.isArray(params.transactions)?params.transactions:[])]){
     if(typeof transaction!=='string')continue;
     const payer=transactionPayer(transaction);if(payer)pins.push(payer);else unknownTransaction=true;
    }
   }
  }
  const specified=pins.filter(value=>value!==undefined);
  if(new Set(specified).size>1)return json({jsonrpc:'2.0',id,error:{code:-32602,message:'Conflicting provider or transaction payer'}},400);
  if(unknownTransaction&&!specified.length&&!operatorId)return json({jsonrpc:'2.0',id,error:{code:-32602,message:'Specify provider or operator for an unrecognized transaction encoding; it will be forwarded unchanged'}},400);
  const mode=url.searchParams.get('selection')||'fastest',priceGroup=url.searchParams.get('priceGroup')||undefined;
  chosen=selectOperator(rows,{mode,payer:specified[0],operatorId,priceGroup,region});
  isQuote=!batch&&body.method==='estimateTransactionFee';
  const result=await forward(chosen.url,raw,positiveSetting(env,'UPSTREAM_TIMEOUT_MS',30000),positiveSetting(env,'MAX_RPC_RESPONSE_BYTES',1048576));
  if(isQuote)ctx.waitUntil(noteQuote(chosen,env,url.origin,region,{ok:result.status>=200&&result.status<300&&!!result.value?.result&&!result.value.error,ms:result.ms,kind:result.status>=500?'transport':result.value?.error?'business':'traffic'}).catch(()=>{}));
  const q=chosen.quoteStats,routing={provider:chosen.payer,providerId:chosen.id,upstreamMs:result.ms,colo:region,
   selection:chosen.selectionBasis||'pinned',advertisedPrice:normalizePrice(chosen.price),
   latencySource:chosen.latencyBasis||'cold-start',quoteEwmaMs:chosen.latencyBasis==='regional-quote-ewma'?q?.ewmaMs:null,
   configMs:chosen.latencyMs===1e9?null:chosen.latencyMs,configEwmaMs:chosen.configStats?.ewmaMs??null};
  // Raw upstream response preserves all numbers, errors and transaction bytes.
  return new Response(result.text||null,{status:result.status,headers:{'content-type':'application/json','access-control-allow-origin':'*','access-control-expose-headers':'x-neiro-routing','cache-control':'no-store','x-neiro-routing':JSON.stringify(routing)}});

 }catch(e){
  if(chosen&&isQuote)ctx.waitUntil(noteQuote(chosen,env,url.origin,region,{ok:false,kind:'transport'}).catch(()=>{}));
  const selectionErrors=['Incomparable advertised pricing; specify priceGroup','Invalid selection options','Selected payer is ambiguous; pin operator ID'];
  return json({jsonrpc:'2.0',id,error:{code:selectionErrors.includes(e.message)?-32602:-32001,message:selectionErrors.includes(e.message)?e.message:'Provider unavailable; requests are never automatically resubmitted'}},selectionErrors.includes(e.message)?400:503);
 }
}};
