import type { ReadEnv } from "./types.js";
import { isRecord } from "./types.js";

export async function measurements(env: ReadEnv) {
  const result = await env.DB.prepare(
    `SELECT r.region,r.operator_id,r.sample_json FROM regional_stats r JOIN operators o ON o.id=r.operator_id WHERE o.status IN ('active','offline') AND r.region NOT IN ('SCHEDULED','unknown') ORDER BY r.region,r.operator_id LIMIT 5001`,
  ).all<{ region: string; operator_id: string; sample_json: string | null }>();
  const now = Date.now();
  const rows = result.results.slice(0, 5000).flatMap((row) => {
    try {
      const s: unknown = JSON.parse(row.sample_json || "null");
      if (
        !isRecord(s) ||
        typeof s.at !== "number" ||
        !Number.isFinite(s.at) ||
        s.at > now ||
        now - s.at > 900000
      )
        return [];
      const latency = s.ewmaMs ?? s.ms;
      return [
        {
          region: row.region,
          operatorId: row.operator_id,
          at: s.at,
          fresh: s.ok === true && now - s.at < 300000,
          latencyMs:
            typeof latency === "number" &&
            Number.isFinite(latency) &&
            latency >= 0
              ? latency
              : null,
        },
      ];
    } catch {
      return [];
    }
  });
  return {
    at: now,
    measurements: rows,
    truncated: result.results.length > 5000,
  };
}

export const dashboard = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEIRO network dashboard</title><style>
:root{color-scheme:dark;background:#10151e;color:#edf3fc;font:15px/1.5 system-ui}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:32px 24px}header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:1px solid #303d50;padding-bottom:22px}h1{font-size:28px;margin:25px 0 4px}h2{font-size:19px;margin:26px 0 12px}p{color:#afbed0}a{color:#84e7c2}.brand{font-weight:700;letter-spacing:2px}.stats{display:flex;gap:16px;flex-wrap:wrap;margin:24px 0}.stat{background:#1a2330;border:1px solid #303d50;border-radius:12px;padding:18px;flex:1;min-width:190px}.stat strong{display:block;font-size:23px}.muted,small{color:#afbed0}button,select{background:#1a2330;border:1px solid #45556d;border-radius:7px;color:inherit;padding:10px;font:inherit}button{cursor:pointer}.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid #303d50}th{color:#afbed0;font-size:13px;font-weight:500}td{font-variant-numeric:tabular-nums}.good{color:#84e7c2}.error{color:#ffbdaf}code{overflow-wrap:anywhere}footer{margin-top:30px;font-size:13px;color:#afbed0}#status{font-size:13px}a:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid #84e7c2}
</style></head><body><main><header><span class="brand">NEIRO / NETWORK</span><a href="https://github.com/bropump/neiro-payment-network-core#connect-your-operator-in-3-steps">Run an operator ↗</a></header><h1>Your network. At a glance.</h1><p>Real operator measurements from Cloudflare locations serving network traffic.</p><div id="status" role="status" aria-live="polite">Loading live measurements…</div><div class="stats"><div class="stat"><span class="muted">Eligible operators here</span><strong id="eligible">—</strong></div><div class="stat"><span class="muted">Fastest sample here</span><strong id="fastest">—</strong></div><div class="stat"><span class="muted">Cheapest comparable sample</span><strong id="cheapest">—</strong></div></div><div class="controls"><label>Sort operators <select id="sort"><option value="speed">Fastest sample</option><option value="price">Cheapest sample</option></select></label><button id="refresh">Refresh</button><span id="colo" class="muted"></span></div><div class="scroll"><table><thead><tr><th>Operator / payer</th><th>Availability here</th><th>Sample response</th><th>Sample fee</th></tr></thead><tbody id="operators"></tbody></table></div><h2>Response times across Cloudflare locations</h2><p>Measured from each location, not the operator’s hosting address. No recent sample means no ranking.</p><div class="scroll"><table id="regions"></table></div><footer>Refreshes every 60 seconds. Speed samples expire after five minutes; fees after eleven minutes. Measurements are API response times, not transaction finality. Actual fees come from your transaction’s Kora quote.<br>Client endpoint: <code id="endpoint"></code></footer></main><script>
const el=id=>document.getElementById(id);let operators=[],metrics=[];const short=s=>s.slice(0,6)+'…'+s.slice(-4);function cell(row,value){const c=document.createElement('td');c.textContent=value;row.append(c);return c;}function validFee(o){const q=o.sampleQuote;return o.eligible&&q&&q.ok===true&&!q.stale&&Number.isSafeInteger(q.feeInToken)&&q.feeInToken>=0&&Date.now()-q.at<660000&&q.at<=Date.now();}function fee(o){return validFee(o)?(o.sampleQuote.feeInToken/1e6).toLocaleString(undefined,{maximumFractionDigits:6})+' NEIRO':'No recent sample';}function draw(){const eligible=operators.filter(o=>o.eligible);el('eligible').textContent=eligible.length+' / '+operators.length;const fast=eligible.filter(o=>Number.isFinite(o.sampleEwmaMs)).sort((a,b)=>a.sampleEwmaMs-b.sampleEwmaMs)[0];el('fastest').textContent=fast?Math.round(fast.sampleEwmaMs)+' ms':'No recent sample';const prices=eligible.filter(validFee);const groups=new Set(prices.map(o=>o.sampleQuote.template+'|'+o.sampleQuote.mint));el('cheapest').textContent=groups.size===1?fee(prices.sort((a,b)=>a.sampleQuote.feeInToken-b.sampleQuote.feeInToken)[0]):'No comparable sample';const rows=[...operators].sort((a,b)=>el('sort').value==='price'&&groups.size===1?(validFee(a)?a.sampleQuote.feeInToken:Infinity)-(validFee(b)?b.sampleQuote.feeInToken:Infinity):(a.eligible?a.sampleEwmaMs??Infinity:Infinity)-(b.eligible?b.sampleEwmaMs??Infinity:Infinity));el('operators').replaceChildren();for(const o of rows){const tr=document.createElement('tr');cell(tr,short(o.id)+' / '+short(o.payer));cell(tr,o.eligible?'Eligible':'Unavailable').className=o.eligible?'good':'muted';cell(tr,o.eligible&&Number.isFinite(o.sampleEwmaMs)?Math.round(o.sampleEwmaMs)+' ms':'No recent sample');cell(tr,fee(o));el('operators').append(tr);}const table=el('regions');table.replaceChildren();const head=document.createElement('tr');for(const text of ['Cloudflare location',...operators.map(o=>short(o.id))]){const th=document.createElement('th');th.textContent=text;head.append(th);}table.append(head);const locations=[...new Set(metrics.map(m=>m.region))].sort();for(const region of locations){const tr=document.createElement('tr');cell(tr,region);for(const o of operators){const m=metrics.find(m=>m.region===region&&m.operatorId===o.id);cell(tr,m&&m.fresh&&Date.now()-m.at<300000&&m.latencyMs!==null?Math.round(m.latencyMs)+' ms · '+Math.floor((Date.now()-m.at)/1000)+'s ago':'No recent sample');}table.append(tr);}if(!locations.length){const tr=document.createElement('tr');cell(tr,'No regional samples yet. Traffic triggers background checks.');table.append(tr);}}
async function refresh(){el('refresh').disabled=true;try{const responses=await Promise.all([fetch('/operators'),fetch('/network/measurements')]);if(responses.some(r=>!r.ok))throw Error('Network data unavailable');const [directory,global]=await Promise.all(responses.map(r=>r.json()));metrics=global.measurements;operators=directory.operators.map(o=>{const m=metrics.find(m=>m.region===directory.colo&&m.operatorId===o.id&&m.fresh&&Date.now()-m.at<300000);return {...o,sampleEwmaMs:m?.latencyMs??o.sampleEwmaMs};});el('colo').textContent='Your Cloudflare location: '+directory.colo;el('status').textContent='Updated '+new Date().toLocaleTimeString()+(global.truncated?' · Regional results limited':'');el('status').className='';draw();}catch{el('status').textContent='Refresh failed. Previous results are no longer shown; retry shortly.';el('status').className='error';operators=[];metrics=[];draw();}finally{el('refresh').disabled=false;}}
el('endpoint').textContent=location.origin+'/rpc';el('sort').addEventListener('change',draw);el('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,60000);
</script></body></html>`;
