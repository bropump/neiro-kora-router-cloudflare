// Passive, sampled acknowledgements only. No transaction, signature or key is stored.
export const SUBMISSION_MAX_AGE_MS = 600000;
export const SUBMISSION_MIN_SUCCESSES = 5;
export const SUBMISSION_MAX_SAMPLES = 32;
export const SUBMISSION_SAMPLE_INTERVAL_MS = 10000;
export function submissionRequest(body) {
 return !!body && !Array.isArray(body) && body.jsonrpc === '2.0' &&
  (typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id))) &&
  body.method === 'signAndSendTransaction' && body.params?.respond_after === 'sent';
}
export function submissionSuccess(body,response) {
 return submissionRequest(body) && response?.jsonrpc === '2.0' && response.id === body.id &&
  !Object.hasOwn(response,'error') && typeof response.result?.signature === 'string' &&
  /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(response.result.signature);
}
export function summarizeSubmissions(events,region,now=Date.now()) {
 const recent=(Array.isArray(events)?events:[]).filter(e=>e && Number.isSafeInteger(e.at) && e.at<=now && e.at>now-SUBMISSION_MAX_AGE_MS && typeof e.ok==='boolean' && Number.isFinite(e.ms) && e.ms>=0)
  .sort((a,b)=>a.at-b.at).slice(-SUBMISSION_MAX_SAMPLES);
 if(!recent.length)return null;
 const values=recent.filter(e=>e.ok).map(e=>e.ms).sort((a,b)=>a-b),n=values.length;
 return {region,method:'signAndSendTransaction',respondAfter:'sent',at:recent.at(-1).at,
  samples:recent.length,successes:n,failures:recent.length-n,successRate:n/recent.length,
  meanMs:n?values.reduce((a,b)=>a+b,0)/n:null,
  medianMs:n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null,
  p95Ms:n?values[Math.ceil(n*0.95)-1]:null};
}
export function usableSubmission(stats,region,now=Date.now()) {
 return stats?.region===region && stats.method==='signAndSendTransaction' && stats.respondAfter==='sent' &&
  Number.isSafeInteger(stats.at) && stats.at<=now && stats.at>now-SUBMISSION_MAX_AGE_MS &&
  Number.isSafeInteger(stats.successes) && stats.successes>=SUBMISSION_MIN_SUCCESSES &&
  Number.isSafeInteger(stats.samples) && stats.samples>=stats.successes && stats.samples<=SUBMISSION_MAX_SAMPLES &&
  stats.successRate>=0.9 && Number.isFinite(stats.medianMs) && stats.medianMs>=0;
}
export async function noteSubmission(row,env,origin,region,{ok,ms}) {
 if(typeof ok!=='boolean'||!Number.isFinite(ms)||ms<0)return;
 const now=Date.now(),cache=globalThis.caches?.default;
 const marker=new Request(`${origin}/_regional/${encodeURIComponent(region)}/submission-recorded/${row.id}`);
 if(await cache?.match(marker))return;
 // Cache throttles ordinary traffic. The SQL predicate also prevents concurrent
 // isolates recording more than one sample per interval. Not a traffic counter.
 await cache?.put(marker,new Response('1',{headers:{'cache-control':'max-age=10'}}));
 await env.DB.prepare(`INSERT INTO regional_stats(region,operator_id,submission_json) VALUES (?,?,?)
 ON CONFLICT(region,operator_id) DO UPDATE SET submission_json=json_insert(
  COALESCE((SELECT json_group_array(json(value)) FROM (SELECT value FROM (
   SELECT key,value FROM json_each(COALESCE(regional_stats.submission_json,'[]'))
   WHERE json_extract(value,'$.at')>? ORDER BY CAST(key AS INTEGER) DESC LIMIT 31
  ) ORDER BY CAST(key AS INTEGER))),'[]'),'$[#]',json(?))
 WHERE COALESCE(json_extract(regional_stats.submission_json,'$[#-1].at'),0)<=?`)
 .bind(region,row.id,JSON.stringify([{at:now,ms,ok}]),now-SUBMISSION_MAX_AGE_MS,JSON.stringify({at:now,ms,ok}),now-SUBMISSION_SAMPLE_INTERVAL_MS).run();
}
