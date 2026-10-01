// Selection uses advertised prices, never a promise of the lowest final payment.
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

export function selectOperator(rows, { mode = 'fastest', payer, operatorId, priceGroup, region, now = Date.now(), healthMaxAgeMs = 300000, quoteMaxAgeMs = 300000 } = {}) {
  if (!['fastest', 'cheapest'].includes(mode) || !validTime(now) || !validLatency(healthMaxAgeMs) || healthMaxAgeMs === 0 || !validLatency(quoteMaxAgeMs) || quoteMaxAgeMs === 0) throw Error('Invalid selection options');
  let candidates = rows.filter(row => row.healthy === true && typeof row.id === 'string' && row.id && fresh(row.checkedAt, now, healthMaxAgeMs) && validLatency(row.latencyMs));
  if (operatorId !== undefined || payer !== undefined) {
    candidates = candidates.filter(row => (operatorId === undefined || row.id === operatorId) && (payer === undefined || row.payer === payer));
    if (candidates.length !== 1) throw Error(candidates.length ? 'Selected payer is ambiguous; pin operator ID' : 'Selected provider unavailable');
    return candidates[0];
  }
  const latency = row => {
    const stats = row.quoteStats;
    return typeof region === 'string' && region && stats?.region === region && fresh(stats.at, now, quoteMaxAgeMs) && validLatency(stats.ewmaMs) && Number.isSafeInteger(stats.samples) && stats.samples > 0 ? stats.ewmaMs : row.latencyMs;
  };
  const compareLatency = (a, b) => latency(a) - latency(b) || a.id.localeCompare(b.id);
  if (mode === 'cheapest') {
    const priced = candidates.map(row => ({ row, price: normalizePrice(row.price) })).filter(entry => entry.price && (priceGroup === undefined || entry.price.group === priceGroup));
    if (new Set(priced.map(entry => entry.price.group)).size > 1) throw Error('Incomparable advertised pricing; specify priceGroup');
    priced.sort((a, b) => {
      const av = a.price.type === 'fixed' ? BigInt(a.price.value) : a.price.value;
      const bv = b.price.type === 'fixed' ? BigInt(b.price.value) : b.price.value;
      return (av < bv ? -1 : av > bv ? 1 : 0) || compareLatency(a.row, b.row);
    });
    candidates = priced.map(entry => entry.row);
  } else candidates.sort(compareLatency);
  if (!candidates.length) throw Error('No healthy provider with comparable pricing or latency');
  return candidates[0];
}
