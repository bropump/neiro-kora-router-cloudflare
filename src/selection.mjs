// Cached equivalent samples or advertised prices are estimates, never a guarantee of the lowest final payment.
const U64_MAX = 18446744073709551615n;
const validLatency = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const fresh = (at, now, age) => validTime(at) && at <= now && now - at < age;

export function normalizePrice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'free') return { type: 'free', group: 'free', value: 0 };
  if (raw.type === 'margin' && typeof raw.margin === 'number' && Number.isFinite(raw.margin) && raw.margin >= 0 && raw.margin <= Number.MAX_SAFE_INTEGER) {
    return { type: 'margin', group: 'margin', value: raw.margin, margin: raw.margin };
  }
  if (raw.type !== 'fixed' || typeof raw.token !== 'string' || !raw.token || typeof raw.strict !== 'boolean') return null;
  const amount = raw.amount;
  if (!(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) && !(typeof amount === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(amount))) return null;
  const units = BigInt(amount);
  if (units > U64_MAX) return null;
  return { type: 'fixed', group: `fixed:${raw.token}:${raw.strict}`, value: units.toString(), amount: units.toString(), token: raw.token, strict: raw.strict };
}

export function recordQuoteSample(previous, { latencyMs, at, region }, { alpha = 0.25, maxAgeMs = 300000 } = {}) {
  if (!validLatency(latencyMs) || !validTime(at) || typeof region !== 'string' || !region || !Number.isFinite(alpha) || alpha <= 0 || alpha > 1 || !validLatency(maxAgeMs) || maxAgeMs === 0) throw Error('Invalid quote sample');
  // A cold region and an expired history both start with their own measurement.
  const reusable = previous && previous.region === region && fresh(previous.at, at, maxAgeMs) && validLatency(previous.ewmaMs) && Number.isSafeInteger(previous.samples) && previous.samples > 0;
  return {
    ewmaMs: reusable ? alpha * latencyMs + (1 - alpha) * previous.ewmaMs : latencyMs,
    samples: reusable ? Math.min(previous.samples + 1, Number.MAX_SAFE_INTEGER) : 1,
    at,
    region,
  };
}

export function selectOperator(rows, { mode = 'fastest', payer, operatorId, priceGroup, region, now = Date.now(), healthMaxAgeMs = 300000, quoteMaxAgeMs = 300000, sampleMaxAgeMs = 660000 } = {}) {
  if (!['fastest', 'cheapest'].includes(mode) || !validTime(now) || ![healthMaxAgeMs, quoteMaxAgeMs, sampleMaxAgeMs].every(x => validLatency(x) && x > 0)) throw Error('Invalid selection options');
  const eligible = row => row.healthy === true && typeof row.id === 'string' && row.id && fresh(row.checkedAt, now, healthMaxAgeMs);
  // Reported payer identity is not a cryptographic ownership proof. Preserve
  // the first verified binding so a later duplicate cannot disable/displace it.
  // Configured endpoints take priority; explicit operator IDs can select a
  // deliberate alternative without silently failing over signed transactions.
  const boundAt = row => validTime(row.identityBoundAt) ? row.identityBoundAt : validTime(row.createdAt) ? row.createdAt : 0;
  const bindings = new Map();
  for (const row of [...rows].sort((a,b)=>Number(!!b.configured)-Number(!!a.configured)||boundAt(a)-boundAt(b)||a.id.localeCompare(b.id))) {
    if (!bindings.has(row.payer)) bindings.set(row.payer,row);
  }
  let candidates;
  if (operatorId !== undefined) {
    candidates=rows.filter(row=>row.id===operatorId&&(payer===undefined||row.payer===payer)&&eligible(row));
    if(candidates.length!==1)throw Error('Selected provider unavailable');
    return {...candidates[0],selectionBasis:'pinned'};
  }
  candidates=[...bindings.values()].filter(eligible);
  if(payer!==undefined){
    const chosen=candidates.find(row=>row.payer===payer);if(!chosen)throw Error('Selected provider unavailable');
    return {...chosen,selectionBasis:'pinned'};
  }
  if (priceGroup !== undefined && mode === 'cheapest') candidates = candidates.filter(row => normalizePrice(row.price)?.group === priceGroup);
  // Compare like with like. A cheap getConfig response must never beat another
  // operator's slower real quote merely because they are different workloads.
  const realQuote = row => row.quoteStats?.source === 'traffic' && row.quoteStats.region === region && fresh(row.quoteStats.at, now, quoteMaxAgeMs) && validLatency(row.quoteStats.ewmaMs) && row.quoteStats.samples > 0;
  const allQuotes = candidates.length > 0 && candidates.every(realQuote);
  const configLatency = row => row.configStats && !row.configStats.failed && row.configStats?.region === region && fresh(row.configStats.at, now, healthMaxAgeMs) && validLatency(row.configStats.latencyMs) ? row.configStats.latencyMs : Infinity;
  const latency = row => allQuotes ? row.quoteStats.ewmaMs : configLatency(row);
  const coldOrder = new Map(candidates.map(row => [row.id,Math.random()]));
  const compareLatency = (a,b) => (latency(a) === latency(b) ? 0 : latency(a) < latency(b) ? -1 : 1) || (!Number.isFinite(latency(a)) ? coldOrder.get(a.id)-coldOrder.get(b.id) : 0) || a.id.localeCompare(b.id);
  let selectionBasis = allQuotes ? 'regional real quote latency' : 'regional configuration latency';
  if (mode === 'cheapest') {
    const sample = row => row.sampleQuote;
    const usable = row => sample(row)?.ok === true && fresh(sample(row).at, now, sampleMaxAgeMs) && typeof sample(row).template === 'string' && !!sample(row).template && typeof sample(row).mint === 'string' && !!sample(row).mint && Number.isSafeInteger(sample(row).feeInToken) && sample(row).feeInToken >= 0;
    const equivalent = candidates.length > 0 && candidates.every(usable) && new Set(candidates.map(row => JSON.stringify([sample(row).template,sample(row).mint]))).size === 1;
    if (equivalent) {
      candidates.sort((a,b) => sample(a).feeInToken - sample(b).feeInToken || compareLatency(a,b));
      selectionBasis = 'lowest fresh comparable sample quote';
    } else {
      let priced = candidates.map(row => ({row,price:normalizePrice(row.price)})).filter(entry => entry.price);
      const free = priced.filter(entry => entry.price.type === 'free');
      if (free.length) priced = free;
      else if (new Set(priced.map(entry => entry.price.group)).size > 1) throw Error('Incomparable advertised pricing; specify priceGroup');
      priced.sort((a,b) => {
        const av = a.price.type === 'fixed' ? BigInt(a.price.value) : a.price.value;
        const bv = b.price.type === 'fixed' ? BigInt(b.price.value) : b.price.value;
        return (av < bv ? -1 : av > bv ? 1 : 0) || compareLatency(a.row,b.row);
      });
      candidates = priced.map(entry => entry.row);
      selectionBasis = 'lowest comparable advertised rate';
    }
  } else candidates.sort(compareLatency);
  if (!candidates.length) throw Error('No healthy provider with comparable pricing or latency');
  const chosen=candidates[0];
  return {...chosen,selectionBasis,latencyBasis:allQuotes?'regional-quote-ewma':Number.isFinite(configLatency(chosen))?'regional-config':'cold-start'};
}
