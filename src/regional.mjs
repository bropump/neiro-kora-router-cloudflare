import {configCheck} from './policy.mjs';
import {upstream} from './upstream.mjs';

// Configuration and sample schedules are shared globally. Latency observations
// remain scoped to their measuring colo; payments never wait for these checks.
const cacheKey=(origin,region,suffix)=>new Request(`${origin}/_regional/${encodeURIComponent(region)}/${suffix}`);
const cache=()=>globalThis.caches?.default;
const safeJSON=text=>{try{return JSON.parse(text);}catch{return null;}};
async function invalidate(origin,region){await cache()?.delete(cacheKey(origin,region,'stats'));}
async function snapshot(env,region){
 const result=await env.DB.prepare('SELECT operator_id,quote_json,config_json,failed_until,last_probe_at FROM regional_stats WHERE region=?').bind(region).all();
 return result.results||[];
}
// Cache both database reads. A short fallback tolerates a transient D1 outage,
// without changing any observation/health timestamps or extending eligibility.
async function cachedRead(origin,region,suffix,read){
 const key=cacheKey(origin,region,suffix),hit=await cache()?.match(key);
 const previous=hit?await hit.json():null,now=Date.now();
 if(previous&&now-previous.at<10000)return previous.rows;
 try{const rows=await read();await cache()?.put(key,Response.json({at:now,rows},{headers:{'cache-control':'max-age=30'}}));return rows;}
 catch(error){if(previous&&now-previous.at<30000)return previous.rows;throw error;}
}
export async function loadRegional(rows,env,origin,region){
 const [stats,shared]=await Promise.all([
  cachedRead(origin,region,'stats',()=>snapshot(env,region)),
  cachedRead(origin,'SHARED','observations',async()=>{const value=await env.DB.prepare('SELECT operator_id,config_json,sample_json FROM operator_observations').all();return value.results||[];})
 ]);
 const byId=new Map(stats.map(s=>[s.operator_id,s])),globalById=new Map(shared.map(s=>[s.operator_id,s]));
 return rows.map(row=>{const s=byId.get(row.id),global=globalById.get(row.id),config=safeJSON(global?.config_json);return {...row,price:config?.price||row.price,sampleQuote:safeJSON(global?.sample_json),quoteStats:safeJSON(s?.quote_json),configStats:safeJSON(s?.config_json),failedUntil:s?.failed_until||0};});
}
export function refreshOptions(env,count){
 const integer=(key,fallback,min,max)=>{const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`Invalid ${key}`);return n;};
 return {batch:integer('REGIONAL_CONFIG_BATCH_SIZE',Math.max(1,Math.min(10000,Math.ceil(count/4))),1,10000),concurrency:integer('CONFIG_CHECK_CONCURRENCY',6,1,32)};
}
// INSERT/UPDATE admission is atomic across Worker isolates. Expired rows are
// reused rather than generating an unbounded new row for every minute.
async function claim(env,key,maximum,now,period=60000){
 return !!await env.DB.prepare(`INSERT INTO regional_leases (id,n,reset) VALUES (?,1,?)
 ON CONFLICT(id) DO UPDATE SET n=CASE WHEN reset<=? THEN 1 ELSE n+1 END,
 reset=CASE WHEN reset<=? THEN ? ELSE reset END WHERE reset<=? OR n<? RETURNING n`)
 .bind(key,now+period,now,now,now+period,now,maximum).first();
}
export async function noteQuote(row,env,origin,region,{ok,ms,kind}){
 const now=Date.now(),source=kind==='probe'?'probe':'traffic';
 if(ok&&Number.isFinite(ms)&&ms>=0){
  // Probe timings never displace fresh real-transaction observations.
  await env.DB.prepare(`INSERT INTO regional_stats(region,operator_id,quote_json,config_json,failed_until)
   VALUES (?,?,json_object('ewmaMs',?,'samples',1,'at',?,'region',?,'source',?),NULL,0)
   ON CONFLICT(region,operator_id) DO UPDATE SET quote_json=json_object(
    'ewmaMs',CASE WHEN json_extract(quote_json,'$.at')>? AND json_extract(quote_json,'$.source')=? THEN 0.25*?+0.75*json_extract(quote_json,'$.ewmaMs') ELSE ? END,
    'samples',CASE WHEN json_extract(quote_json,'$.at')>? AND json_extract(quote_json,'$.source')=? THEN MIN(COALESCE(json_extract(quote_json,'$.samples'),0)+1,1000000) ELSE 1 END,
    'at',?,'region',?,'source',?),failed_until=0
   WHERE ?!='probe' OR COALESCE(json_extract(quote_json,'$.source'),'')!='traffic' OR COALESCE(json_extract(quote_json,'$.at'),0)<=?`)
   .bind(region,row.id,ms,now,region,source,now-300000,source,ms,ms,now-300000,source,now,region,source,source,now-300000).run();
 }else if(!ok&&['transport','protocol'].includes(kind)){
  await env.DB.prepare(`INSERT INTO regional_stats(region,operator_id,quote_json,config_json,failed_until) VALUES (?,?,NULL,NULL,?)
   ON CONFLICT(region,operator_id) DO UPDATE SET failed_until=MAX(failed_until,excluded.failed_until)`)
   .bind(region,row.id,now+30000).run();
 }else return;
 await invalidate(origin,region);
}
// Minute buckets distribute quote sampling over ten minutes. Stable sorted
// positions give exactly ten samples/minute for a stable 100-operator pool.
export function quoteBucket(rows,now){const minute=Math.floor(now/60000)%10;return [...rows].sort((a,b)=>a.id.localeCompare(b.id)).filter((_,i)=>i%10===minute);}
export async function refreshRegional(rows,env,origin,region,probe,{onConfig}={}){
 if(!rows.length)return;
 const now=Date.now(),key=cacheKey(origin,region,'refresh');
 const options=refreshOptions(env,rows.length);
 const scheduled=region==='SCHEDULED',configDeadline=now+(scheduled?120000:12000),probeDeadline=now+(scheduled?240000:21000);
 if(await cache()?.match(key))return;
 // Shared admission avoids every edge independently scanning the directory.
 // A short sweep lease lets another invocation finish work after interruption;
 // the per-operator leases prevent duplicate upstream checks.
 // Cron must retain a recovery lane for offline rows, which traffic pools omit.
 // Per-operator leases below still deduplicate checks between both lanes.
 const ownsSweep=await claim(env,scheduled?'background:sweep:scheduled':'background:sweep:traffic',1,now,15000);
 await cache()?.put(key,new Response('1',{headers:{'cache-control':'max-age=15'}}));
 async function check(row,regional=false){
  const leaseKey=regional?`config:regional:${region}:${row.id}`:`config:operator:${row.id}`;
  if(!await claim(env,leaseKey,1,Math.floor(Date.now()/60000)*60000,60000))return;
  try{
   const response=await upstream(row.url,'getConfig',{},2000);
   configCheck(response.value.result,{signer_address:row.payer,payment_address:row.paymentAddress},env.NEIRO_MINT);
   const value={latencyMs:response.ms,at:Date.now(),region,price:response.value.result.validation_config.price};
   await env.DB.prepare(`INSERT INTO operator_observations(operator_id,config_json) VALUES (?,?)
    ON CONFLICT(operator_id) DO UPDATE SET config_json=excluded.config_json`).bind(row.id,JSON.stringify(value)).run();
   await env.DB.prepare(`INSERT INTO regional_stats(region,operator_id,quote_json,config_json,failed_until) VALUES (?,?,NULL,?,0)
    ON CONFLICT(region,operator_id) DO UPDATE SET config_json=excluded.config_json,failed_until=0`)
    .bind(region,row.id,JSON.stringify(value)).run();
   await onConfig?.(row,{ok:true,config:response.value.result,ms:response.ms,at:value.at});
  }catch{
   // Failed or throttled endpoints get a two-minute quiet period.
   await env.DB.prepare('UPDATE regional_leases SET reset=MAX(reset,?) WHERE id=?').bind(Date.now()+120000,leaseKey).run();
   if(!regional)await env.DB.prepare(`INSERT INTO operator_observations(operator_id,config_json) VALUES (?,?) ON CONFLICT(operator_id) DO UPDATE SET config_json=excluded.config_json`).bind(row.id,JSON.stringify({at:Date.now(),failed:true,region})).run();
   await noteQuote(row,env,origin,region,{ok:false,kind:'protocol'});
   await env.DB.prepare(`UPDATE regional_stats SET config_json=? WHERE region=? AND operator_id=?`)
    .bind(JSON.stringify({at:Date.now(),region,price:null,latencyMs:null,failed:true}),region,row.id).run();
   // A regional network failure must not disable a healthy operator globally.
   if(!regional)await onConfig?.(row,{ok:false,kind:'protocol',at:Date.now()});
  }
 }
 // Four batches/minute target complete coverage/minute, proportional to pool
 // size. The time budget/concurrency still bound each invocation; slow endpoints
 // can delay coverage. Oldest-first resumes unfinished work on the next batch.
 if(!scheduled&&await claim(env,`config:regional-window:${region}`,1,now,15000)){
  const local=await snapshot(env,region),byId=new Map(local.map(s=>[s.operator_id,s]));
  const oldest=[...rows].sort((a,b)=>(safeJSON(byId.get(a.id)?.config_json)?.at||0)-(safeJSON(byId.get(b.id)?.config_json)?.at||0)||a.id.localeCompare(b.id)).slice(0,options.batch);
  for(let i=0;i<oldest.length&&Date.now()<configDeadline;i+=options.concurrency)await Promise.all(oldest.slice(i,i+options.concurrency).map(row=>check(row,true)));
 }
 if(!ownsSweep){await invalidate(origin,region);return;}
 // Bounded batches: no unbounded Promise.all or sleeps occupying request work.
 const observedConfigs=await env.DB.prepare('SELECT operator_id,config_json FROM operator_observations').all();
 const configAt=new Map((observedConfigs.results||[]).map(s=>[s.operator_id,safeJSON(s.config_json)?.at||0]));
 const due=[...rows].sort((a,b)=>(configAt.get(a.id)||0)-(configAt.get(b.id)||0)||a.id.localeCompare(b.id));
 for(let i=0;i<due.length&&Date.now()<configDeadline;i+=options.concurrency)await Promise.all(due.slice(i,i+options.concurrency).map(row=>check(row)));
 if(typeof probe==='function'){
  const observed=await env.DB.prepare('SELECT operator_id,config_json FROM operator_observations').all();
  const eligible=new Set((observed.results||[]).filter(s=>{const c=safeJSON(s.config_json);return c&&!c.failed&&c.at>Date.now()-300000;}).map(s=>s.operator_id));
  const samples=await env.DB.prepare('SELECT operator_id,sample_json FROM operator_observations').all();
  const sampledAt=new Map((samples.results||[]).map(s=>[s.operator_id,safeJSON(s.sample_json)?.at||0]));
  const selected=quoteBucket(rows,now).filter(row=>eligible.has(row.id)).sort((a,b)=>(sampledAt.get(a.id)||0)-(sampledAt.get(b.id)||0));
  async function sample(row){
   if(!await claim(env,`quote:operator:${row.id}`,1,Math.floor(Date.now()/600000)*600000,600000))return;
   let result;try{result=await probe(row);}catch{result={ok:false,kind:'transport'};}
   const at=Date.now();
   const value={ok:!!result.ok,at,region,template:'unsigned-empty-v1',mint:env.NEIRO_MINT,
    ...(result.ok?{feeInToken:result.feeInToken,feeInLamports:result.feeInLamports,ms:result.ms}:{kind:result.kind})};
   await env.DB.prepare(`INSERT INTO operator_observations(operator_id,sample_json) VALUES (?,?)
    ON CONFLICT(operator_id) DO UPDATE SET sample_json=excluded.sample_json`).bind(row.id,JSON.stringify(value)).run();
   await noteQuote(row,env,origin,region,result);
  }
  for(let i=0;i<selected.length&&Date.now()<probeDeadline;i+=2)await Promise.all(selected.slice(i,i+2).map(sample));
 }
 await invalidate(origin,region);
}
