import type {
  CachedRows,
  ConfigEvent,
  ConfigStats,
  Env,
  KoraConfig,
  Operator,
  ProbeResult,
  QuoteEvent,
  QuoteStats,
  ReadEnv,
  RegionalRow,
  Sample,
  Settings,
} from "./types.js";
import { summarizeSubmissions } from "./submission.js";
import { configCheck } from "./policy.js";
import { upstream } from "./upstream.js";
import { boundedSetting } from "./lifecycle.js";

// Measurements are scoped to the serving colo. Shared prices provide a cold
// region fallback; payments never wait for background operator checks.
const cacheKey = (origin: string, region: string, suffix: string) =>
  new Request(`${origin}/_regional/${encodeURIComponent(region)}/${suffix}`);
const cache = () => (globalThis as { caches?: CacheStorage }).caches?.default;
const safeJSON = <T>(text: string | null | undefined): T | null => {
  try {
    return JSON.parse(text!) as T;
  } catch {
    return null;
  }
};
async function failureOverlay(
  origin: string,
  region: string,
  id: string,
  until: number,
) {
  await cache()?.put(
    cacheKey(origin, region, `failure/${id}`),
    Response.json({ until }, { headers: { "cache-control": "max-age=30" } }),
  );
}
export async function localFailureUntil(
  origin: string,
  region: string,
  id: string,
) {
  const hit = await cache()?.match(cacheKey(origin, region, `failure/${id}`));
  return hit ? (await hit.json<{ until: number }>()).until || 0 : 0;
}
async function snapshot(env: ReadEnv, region: string) {
  const result = await env.DB.prepare(
    "SELECT operator_id,quote_json,config_json,sample_json,submission_json,failed_until,last_probe_at FROM regional_stats WHERE region=?",
  )
    .bind(region)
    .all<RegionalRow>();
  return result.results || [];
}
// Cache both database reads. A short fallback tolerates a transient D1 outage,
// without changing any observation/health timestamps or extending eligibility.
async function cachedRead<T>(
  origin: string,
  region: string,
  suffix: string,
  read: () => Promise<T[]>,
  ctx?: ExecutionContext,
) {
  const key = cacheKey(origin, region, suffix),
    hit = await cache()?.match(key);
  const previous = hit ? await hit.json<CachedRows<T>>() : null,
    now = Date.now();
  if (previous && now >= previous.at && now - previous.at < 60000)
    return previous.rows;
  async function update() {
    const rows = await read();
    await cache()?.put(
      key,
      Response.json(
        { at: now, rows },
        { headers: { "cache-control": "max-age=120" } },
      ),
    );
    return rows;
  }
  // Return bounded local observations while refreshing off the request path.
  if (
    previous &&
    now >= previous.at &&
    now - previous.at < 120000 &&
    ctx?.waitUntil
  ) {
    const marker = cacheKey(origin, region, `${suffix}-refreshing`);
    if (!(await cache()?.match(marker))) {
      await cache()?.put(
        marker,
        new Response("1", { headers: { "cache-control": "max-age=5" } }),
      );
      ctx.waitUntil(update().catch(() => {}));
    }
    return previous.rows;
  }
  try {
    return await update();
  } catch (error) {
    if (previous && now >= previous.at && now - previous.at < 120000)
      return previous.rows;
    throw error;
  }
}
export async function loadRegional(
  rows: Operator[],
  env: ReadEnv,
  origin: string,
  region: string,
  ctx?: ExecutionContext,
) {
  const [stats, shared] = await Promise.all([
    cachedRead(origin, region, "stats", () => snapshot(env, region), ctx),
    cachedRead(
      origin,
      "SHARED",
      "observations",
      async () => {
        const value = await env.DB.prepare(
          "SELECT operator_id,config_json,sample_json FROM operator_observations",
        ).all<RegionalRow>();
        return value.results || [];
      },
      ctx,
    ),
  ]);
  const byId = new Map(stats.map((s) => [s.operator_id, s])),
    globalById = new Map(shared.map((s) => [s.operator_id, s]));
  return rows.map((row) => {
    const s = byId.get(row.id),
      global = globalById.get(row.id),
      config = safeJSON<ConfigStats>(global?.config_json),
      sample = safeJSON<Sample>(s?.sample_json);
    const fresh =
      sample && sample.at <= Date.now() && sample.at > Date.now() - 300000;
    return {
      ...row,
      price: config?.price || row.price,
      sampleQuote: fresh ? sample : safeJSON<Sample>(global?.sample_json),
      sampleStats: fresh ? sample : null,
      submissionStats: summarizeSubmissions(
        safeJSON(s?.submission_json),
        region,
      ),
      quoteStats: safeJSON<QuoteStats>(s?.quote_json),
      configStats: safeJSON<ConfigStats>(s?.config_json),
      failedUntil: s?.failed_until || 0,
    };
  });
}
export function refreshOptions(env: Settings, count: number) {
  const integer = (
    key: keyof Settings,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw Error(`Invalid ${key}`);
    return n;
  };
  return {
    batch: integer(
      "REGIONAL_CONFIG_BATCH_SIZE",
      Math.max(1, Math.min(count, 12)),
      1,
      12,
    ),
    concurrency: integer("CONFIG_CHECK_CONCURRENCY", 2, 1, 2),
  };
}
// INSERT/UPDATE admission is atomic across Worker isolates. Expired rows are
// reused rather than generating an unbounded new row for every minute.
async function claim(
  env: Env,
  key: string,
  maximum: number,
  now: number,
  period = 60000,
) {
  return !!(await env.DB.prepare(
    `INSERT INTO regional_leases (id,n,reset) VALUES (?,1,?)
 ON CONFLICT(id) DO UPDATE SET n=CASE WHEN reset<=? THEN 1 ELSE n+1 END,
 reset=CASE WHEN reset<=? THEN ? ELSE reset END WHERE reset<=? OR n<? RETURNING n`,
  )
    .bind(key, now + period, now, now, now + period, now, maximum)
    .first());
}
export async function noteQuote(
  row: Operator,
  env: Env,
  origin: string,
  region: string,
  { ok, ms, kind }: QuoteEvent,
) {
  const now = Date.now(),
    source = kind === "probe" ? "probe" : "traffic";
  // Immediately suppress local failures, even if the persistence write fails.
  if (!ok && ["transport", "protocol"].includes(kind))
    await failureOverlay(origin, region, row.id, now + 30000);
  if (ok && typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
    // Customer timings are diagnostic, not the sample ranking signal. Avoid a
    // persistence write per payment; this best-effort local throttle needs no D1.
    const marker = cacheKey(origin, region, `traffic-recorded/${row.id}`);
    if (await cache()?.match(marker)) return;
    await cache()?.put(
      marker,
      new Response("1", { headers: { "cache-control": "max-age=60" } }),
    );
    // Probe timings never displace fresh real-transaction observations.
    await env.DB.prepare(
      `INSERT INTO regional_stats(region,operator_id,quote_json,config_json,failed_until)
   VALUES (?,?,json_object('ewmaMs',?,'samples',1,'at',?,'region',?,'source',?),NULL,0)
   ON CONFLICT(region,operator_id) DO UPDATE SET quote_json=json_object(
    'ewmaMs',CASE WHEN json_extract(quote_json,'$.at')>? AND json_extract(quote_json,'$.source')=? THEN 0.25*?+0.75*json_extract(quote_json,'$.ewmaMs') ELSE ? END,
    'samples',CASE WHEN json_extract(quote_json,'$.at')>? AND json_extract(quote_json,'$.source')=? THEN MIN(COALESCE(json_extract(quote_json,'$.samples'),0)+1,1000000) ELSE 1 END,
    'at',?,'region',?,'source',?),failed_until=0
   WHERE ?!='probe' OR COALESCE(json_extract(quote_json,'$.source'),'')!='traffic' OR COALESCE(json_extract(quote_json,'$.at'),0)<=?`,
    )
      .bind(
        region,
        row.id,
        ms,
        now,
        region,
        source,
        now - 300000,
        source,
        ms,
        ms,
        now - 300000,
        source,
        now,
        region,
        source,
        source,
        now - 300000,
      )
      .run();
  } else if (!ok && ["transport", "protocol"].includes(kind)) {
    await env.DB.prepare(
      `INSERT INTO regional_stats(region,operator_id,quote_json,config_json,failed_until) VALUES (?,?,NULL,NULL,?)
   ON CONFLICT(region,operator_id) DO UPDATE SET failed_until=MAX(failed_until,excluded.failed_until)`,
    )
      .bind(region, row.id, now + 30000)
      .run();
  } else return;
}
// Stable oldest-first batches spread work across active requests. Per-operator
// leases enforce the minute interval across isolates; no provider fan-out occurs
// in the foreground request handler.
export async function refreshRegional(
  rows: Operator[],
  env: Env,
  origin: string,
  region: string,
  probe: (row: Operator) => Promise<ProbeResult>,
  {
    onConfig,
  }: { onConfig?: (row: Operator, event: ConfigEvent) => Promise<void> } = {},
) {
  if (!rows.length) return;
  const now = Date.now(),
    key = cacheKey(origin, region, "refresh"),
    options = refreshOptions(env, rows.length);
  const wakeMs = 60000;
  const interval = boundedSetting(
    env,
    "REGIONAL_PROBE_INTERVAL_MS",
    180000,
    240000,
  );
  if (await cache()?.match(key)) return;
  await cache()?.put(
    key,
    new Response("1", {
      headers: { "cache-control": `max-age=${wakeMs / 1000}` },
    }),
  );
  if (!(await claim(env, `background:sweep:${region}`, 1, now, wakeMs))) return;
  const scheduled = region === "SCHEDULED",
    deadline = now + 20000;
  const local = await snapshot(env, region),
    byId = new Map(local.map((s) => [s.operator_id, s]));
  const age = (row: Operator) => byId.get(row.id)?.last_probe_at || 0;
  const selected = [...rows]
    .filter((row) => now - age(row) >= interval)
    .sort((a, b) => age(a) - age(b) || a.id.localeCompare(b.id))
    .slice(0, options.batch);
  async function check(row: Operator) {
    const leaseKey = `config:regional:${region}:${row.id}`;
    if (!(await claim(env, leaseKey, 1, Date.now(), interval))) return;
    // Persist attempts, including failures, so later invocations continue fairly.
    await env.DB.prepare(
      "INSERT INTO regional_stats(region,operator_id,last_probe_at) VALUES (?,?,?) ON CONFLICT(region,operator_id) DO UPDATE SET last_probe_at=excluded.last_probe_at",
    )
      .bind(region, row.id, Date.now())
      .run();
    try {
      const response = await upstream<KoraConfig>(
        row.url,
        "getConfig",
        {},
        2000,
      );
      configCheck(
        response.value.result,
        { signer_address: row.payer, payment_address: row.paymentAddress },
        env.NEIRO_MINT,
      );
      const value = {
        latencyMs: response.ms,
        at: Date.now(),
        region,
        price: response.value.result!.validation_config!.price,
      };
      await env.DB.prepare(
        `INSERT INTO regional_stats(region,operator_id,quote_json,config_json,failed_until) VALUES (?,?,NULL,?,0)
    ON CONFLICT(region,operator_id) DO UPDATE SET config_json=json_set(excluded.config_json,'$.ewmaMs',
    CASE WHEN json_extract(regional_stats.config_json,'$.at')>? AND COALESCE(json_extract(regional_stats.config_json,'$.failed'),0)=0
    AND COALESCE(json_extract(regional_stats.config_json,'$.ewmaMs'),json_extract(regional_stats.config_json,'$.latencyMs'))>=0
    THEN 0.25*json_extract(excluded.config_json,'$.latencyMs')+0.75*COALESCE(json_extract(regional_stats.config_json,'$.ewmaMs'),json_extract(regional_stats.config_json,'$.latencyMs'))
    ELSE json_extract(excluded.config_json,'$.latencyMs') END),failed_until=0`,
      )
        .bind(region, row.id, JSON.stringify(value), value.at - 300000)
        .run();
      // Shared eligibility/config updates are limited globally, while every active
      // colo retains its own timings. Scheduled checks are the recovery lane.
      if (await claim(env, `config:operator:${row.id}`, 1, Date.now(), 60000)) {
        await env.DB.prepare(
          `INSERT INTO operator_observations(operator_id,config_json) VALUES (?,?)
     ON CONFLICT(operator_id) DO UPDATE SET config_json=excluded.config_json`,
        )
          .bind(row.id, JSON.stringify(value))
          .run();
        await onConfig?.(row, {
          ok: true,
          config: response.value.result!,
          ms: response.ms,
          at: value.at,
        });
      }
      byId.set(row.id, {
        operator_id: row.id,
        ...byId.get(row.id),
        config_json: JSON.stringify(value),
      });
    } catch {
      await failureOverlay(origin, region, row.id, Date.now() + 30000);
      await env.DB.prepare(
        "UPDATE regional_leases SET reset=MAX(reset,?) WHERE id=?",
      )
        .bind(Date.now() + 120000, leaseKey)
        .run();
      await noteQuote(row, env, origin, region, {
        ok: false,
        kind: "protocol",
      });
      const value = {
        at: Date.now(),
        region,
        price: null,
        latencyMs: null,
        failed: true,
      };
      await env.DB.prepare(
        `UPDATE regional_stats SET config_json=? WHERE region=? AND operator_id=?`,
      )
        .bind(JSON.stringify(value), region, row.id)
        .run();
      byId.set(row.id, {
        operator_id: row.id,
        ...byId.get(row.id),
        config_json: JSON.stringify(value),
      });
      if (scheduled)
        await onConfig?.(row, { ok: false, kind: "protocol", at: value.at });
    }
  }
  async function sample(row: Operator) {
    const config = safeJSON<ConfigStats>(byId.get(row.id)?.config_json);
    if (
      !config ||
      config.failed ||
      config.at < Date.now() - 300000 ||
      typeof probe !== "function"
    )
      return;
    const leaseKey = `quote:regional:${region}:${row.id}`;
    if (!(await claim(env, leaseKey, 1, Date.now(), interval))) return;
    let result: ProbeResult;
    try {
      result = await probe(row);
    } catch {
      result = { ok: false, kind: "transport" };
    }
    const at = Date.now(),
      value = {
        ok: !!result.ok,
        at,
        region,
        template: "unsigned-empty-v1",
        mint: env.NEIRO_MINT,
        ...(result.ok
          ? {
              feeInToken: result.feeInToken,
              feeInLamports: result.feeInLamports,
              ms: result.ms,
            }
          : { kind: result.kind }),
      };
    // Sample EWMA is separate from arbitrary customer transactions. SQL updates
    // atomically and resets the average after a stale/failed sample.
    await env.DB.prepare(
      `INSERT INTO regional_stats(region,operator_id,sample_json) VALUES (?,?,json_set(?,'$.ewmaMs',?,'$.samples',1))
   ON CONFLICT(region,operator_id) DO UPDATE SET sample_json=json_set(excluded.sample_json,
    '$.ewmaMs',CASE WHEN json_extract(excluded.sample_json,'$.ok')=1 AND json_extract(regional_stats.sample_json,'$.ok')=1 AND json_extract(regional_stats.sample_json,'$.at')>?
      THEN 0.25*json_extract(excluded.sample_json,'$.ms')+0.75*json_extract(regional_stats.sample_json,'$.ewmaMs') ELSE json_extract(excluded.sample_json,'$.ms') END,
    '$.samples',CASE WHEN json_extract(excluded.sample_json,'$.ok')=1 AND json_extract(regional_stats.sample_json,'$.ok')=1 AND json_extract(regional_stats.sample_json,'$.at')>?
      THEN MIN(COALESCE(json_extract(regional_stats.sample_json,'$.samples'),0)+1,1000000) ELSE 1 END)`,
    )
      .bind(
        region,
        row.id,
        JSON.stringify(value),
        result.ok ? result.ms : null,
        at - 300000,
        at - 300000,
      )
      .run();
    // Price observations may be shared across regions; timing never is.
    if (await claim(env, `quote:shared:${row.id}`, 1, Date.now(), 60000))
      await env.DB.prepare(
        `INSERT INTO operator_observations(operator_id,sample_json) VALUES (?,?)
   ON CONFLICT(operator_id) DO UPDATE SET sample_json=excluded.sample_json`,
      )
        .bind(row.id, JSON.stringify(value))
        .run();
    if (!result.ok) {
      await env.DB.prepare(
        "UPDATE regional_leases SET reset=MAX(reset,?) WHERE id=?",
      )
        .bind(at + 120000, leaseKey)
        .run();
      await noteQuote(row, env, origin, region, result);
    }
  }
  // Finish each operator's config + quote together, so configs cannot starve quotes.
  for (
    let i = 0;
    i < selected.length && Date.now() < deadline;
    i += options.concurrency
  )
    await Promise.all(
      selected.slice(i, i + options.concurrency).map(async (row) => {
        await check(row);
        if (Date.now() < deadline) await sample(row);
      }),
    );
}
