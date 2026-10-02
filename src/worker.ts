import { isRecord } from "./types.js";
import type {
  CachedRows,
  ConfiguredOperator,
  ConfigEvent,
  Env,
  KoraIdentity,
  Operator,
  OperatorStatus,
  ReadEnv,
  Registration,
  RpcEnvelope,
  RpcRequest,
  Settings,
  StoredOperator,
} from "./types.js";
import {
  submissionRequest,
  submissionSuccess,
  noteSubmission,
  SUBMISSION_MAX_AGE_MS,
} from "./submission.js";
import { endpoint, bodyJSON, bounded, json } from "./policy.js";
import { inspect, ownership, upstream, forward } from "./upstream.js";
import { selectOperator, normalizePrice } from "./selection.js";
import {
  loadRegional,
  noteQuote,
  refreshRegional,
  localFailureUntil,
} from "./regional.js";
import { probeQuote, transactionPayer } from "./probe.js";
const hash = async (s: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
async function budget(env: Env, key: string, max: number) {
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT INTO limits (id,n,reset) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET n=CASE WHEN reset<=? THEN 1 ELSE n+1 END, reset=CASE WHEN reset<=? THEN ? ELSE reset END WHERE reset<=? OR n<? RETURNING n",
  )
    .bind(key, now + 3600000, now, now, now + 3600000, now, max)
    .first();
  return !!result;
}
function configuredOperators(env: Settings): ConfiguredOperator[] {
  const entries: unknown = JSON.parse(env.CONFIGURED_OPERATORS || "[]");
  if (!Array.isArray(entries)) throw Error("Invalid configured operators");
  return (entries as unknown[]).map((x) => {
    if (
      !isRecord(x) ||
      typeof x.payer !== "string" ||
      typeof x.paymentAddress !== "string" ||
      ![x.payer, x.paymentAddress].every((v) =>
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v),
      )
    )
      throw Error("Invalid configured identity");
    return {
      url: endpoint(x.url, (env.ROUTER_HOSTS || "").split(",")),
      payer: x.payer,
      paymentAddress: x.paymentAddress,
    };
  });
}
async function check(
  env: Env,
  row: Registration,
  identityOnly = false,
  attempt: number,
) {
  try {
    const configured = configuredOperators(env).find((x) => x.url === row.url);
    if (!configured && !(await ownership(row))) {
      await removeOperator(env, row.id);
      row.status = "removed";
      return;
    }
    if (
      identityOnly &&
      row.payer &&
      row.paymentAddress &&
      row.verifiedAt &&
      row.status !== "disabled"
    ) {
      const identity = (await upstream<KoraIdentity>(row.url, "getPayerSigner"))
        .value.result;
      if (
        identity?.signer_address !== row.payer ||
        identity.payment_address !== row.paymentAddress
      )
        throw Error("Operator identity changed");
      // Identity inspection owns only verifiedAt; never restore a stale health/status snapshot.
      await env.DB.prepare(
        "UPDATE operators SET data=json_set(data,'$.verifiedAt',?) WHERE id=? AND last_attempt=?",
      )
        .bind(Date.now(), row.id, attempt)
        .run();
      return;
    }
    const measured = await inspect(row.url, env.NEIRO_MINT);
    if (
      configured &&
      (measured.payer !== configured.payer ||
        measured.paymentAddress !== configured.paymentAddress)
    )
      throw Error("Configured operator identity changed");
    if (
      row.payer &&
      (row.payer !== measured.payer ||
        row.paymentAddress !== measured.paymentAddress)
    )
      throw Error("Operator identity changed; remove and re-register");
    const now = Date.now();
    const updated = await env.DB.prepare(
      `UPDATE operators SET status='active',checked_at=?,data=json_set(data,
 '$.status','active','$.healthy',json('true'),'$.checkedAt',?,'$.verifiedAt',?,
 '$.identityBoundAt',COALESCE(json_extract(data,'$.identityBoundAt'),CASE WHEN json_extract(data,'$.payer') IS NOT NULL THEN created_at ELSE ? END),
 '$.payer',?,'$.paymentAddress',?,'$.latencyMs',?,'$.price',json(?)) WHERE id=? AND last_attempt=? AND checked_at<=? RETURNING status`,
    )
      .bind(
        measured.checkedAt,
        measured.checkedAt,
        now,
        now,
        measured.payer,
        measured.paymentAddress,
        measured.latencyMs,
        JSON.stringify(measured.price ?? null),
        row.id,
        attempt,
        measured.checkedAt,
      )
      .first<{ status: OperatorStatus }>();
    if (updated) row.status = "active";
  } catch (e) {
    const now = Date.now(),
      status = row.status === "pending" ? "pending" : "disabled";
    const updated = await env.DB.prepare(
      "UPDATE operators SET status=?,checked_at=?,data=json_set(data,'$.status',?,'$.healthy',json('false'),'$.checkedAt',?,'$.verifiedAt',?) WHERE id=? AND last_attempt=? RETURNING status",
    )
      .bind(status, now, status, now, now, row.id, attempt)
      .first<{ status: OperatorStatus }>();
    if (updated) row.status = status;
    throw e;
  }
}
async function removeOperator(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operators WHERE id=?").bind(id),
    env.DB.prepare("DELETE FROM regional_stats WHERE operator_id=?").bind(id),
    env.DB.prepare(
      "DELETE FROM operator_observations WHERE operator_id=?",
    ).bind(id),
  ]);
}
function positiveSetting(env: Settings, key: keyof Settings, fallback: number) {
  const n = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw Error("Invalid " + key);
  return n;
}
async function enroll(
  action: string,
  input: { url?: unknown; id?: unknown },
  ip: string,
  env: Env,
) {
  if (
    !(await budget(
      env,
      "ip:" + (await hash(ip)),
      positiveSetting(env, "ADMISSION_REQUESTS_PER_IP_HOUR", 60),
    ))
  )
    return json({ error: "Registration limit reached; try later" }, 429);
  if (action === "register") {
    const url = endpoint(input.url, (env.ROUTER_HOSTS || "").split(",")),
      id = (await hash(url)).slice(0, 32);
    await env.DB.prepare(
      "DELETE FROM operators WHERE status='pending' AND created_at<?",
    )
      .bind(Date.now() - 900000)
      .run();
    let stored = await env.DB.prepare("SELECT data FROM operators WHERE id=?")
      .bind(id)
      .first<StoredOperator>();
    if (!stored) {
      const row: Registration = {
        id,
        url,
        token: crypto.randomUUID() + crypto.randomUUID(),
        status: "pending",
        createdAt: Date.now(),
        checkedAt: 0,
      };
      await env.DB.prepare(
        "INSERT OR IGNORE INTO operators (id,host,status,created_at,checked_at,last_attempt,data) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(
          id,
          new URL(url).hostname,
          "pending",
          row.createdAt,
          0,
          0,
          JSON.stringify(row),
        )
        .run();
      stored = await env.DB.prepare("SELECT data FROM operators WHERE id=?")
        .bind(id)
        .first<StoredOperator>();
      if (!stored)
        return json({ error: "Registration could not be stored" }, 409);
    }
    const row = JSON.parse(stored.data) as Registration;
    return json({
      id: row.id,
      status: row.status,
      verificationUrl: new URL("/.well-known/neiro-router/" + id, url).href,
      verification: { token: row.token, enabled: true },
      next: "Serve this JSON at verificationUrl, then POST /operators/verify with id. Keep the file available; no wallet signature or daily renewal.",
    });
  }
  if (action === "remove") {
    if (typeof input.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id))
      return json({ error: "Invalid registration ID" }, 400);
    const stored = await env.DB.prepare("SELECT data FROM operators WHERE id=?")
      .bind(input.id)
      .first<StoredOperator>();
    if (!stored) return json({ error: "Unknown registration" }, 404);
    const row = JSON.parse(stored.data) as Registration;
    if (configuredOperators(env).some((x) => x.url === row.url))
      return json(
        {
          error:
            "Configured operator must be removed from deployment configuration",
        },
        409,
      );
    // An ID or public token alone grants no authority: verify the owner-controlled HTTPS proof.
    if ((await ownership(row)) !== false)
      return json(
        { error: "Set enabled:false in the ownership proof before removal" },
        409,
      );
    await removeOperator(env, row.id);
    return json({ id: row.id, status: "removed" });
  }
  if (action === "verify") {
    if (typeof input.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id))
      return json({ error: "Invalid registration ID" }, 400);
    const now = Date.now();
    const stored = await env.DB.prepare(
      "UPDATE operators SET last_attempt=? WHERE id=? AND last_attempt<? RETURNING data",
    )
      .bind(now, input.id, now - 60000)
      .first<StoredOperator>();
    if (!stored)
      return json(
        { error: "Unknown registration or verification cooldown" },
        429,
      );
    const row = JSON.parse(stored.data) as Registration;
    try {
      await check(env, row, false, now);
      return json({ id: row.id, status: row.status });
    } catch {
      return json(
        {
          id: row.id,
          status: row.status,
          error: "Verification or Kora health failed",
        },
        422,
      );
    }
  }
  return json({ error: "Not found" }, 404);
}
// Minute cron prunes abandoned state in bounded batches. Keep a 15-minute
// grace beyond active measurements and lease deadlines; never delete live leases.
export async function pruneRoutingState(env: Env, now = Date.now()) {
  const cutoff = now - 900000;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE regional_stats SET submission_json=(SELECT json_group_array(json(value)) FROM json_each(regional_stats.submission_json) WHERE json_extract(value,'$.at')>?)
   WHERE rowid IN (SELECT rowid FROM regional_stats WHERE json_extract(submission_json,'$[0].at')<=? LIMIT 500)`,
    ).bind(now - SUBMISSION_MAX_AGE_MS, now - SUBMISSION_MAX_AGE_MS),
    env.DB.prepare(
      `DELETE FROM regional_stats WHERE rowid IN (SELECT rowid FROM regional_stats WHERE failed_until<=? AND (operator_id NOT IN (SELECT id FROM operators) OR MAX(COALESCE(json_extract(config_json,'$.at'),0),COALESCE(json_extract(quote_json,'$.at'),0),COALESCE(json_extract(sample_json,'$.at'),0))<? AND COALESCE(json_extract(submission_json,'$[#-1].at'),0)<=?) LIMIT 500)`,
    ).bind(now, cutoff, now - SUBMISSION_MAX_AGE_MS),
    env.DB.prepare(
      `DELETE FROM operator_observations WHERE rowid IN (SELECT rowid FROM operator_observations WHERE operator_id NOT IN (SELECT id FROM operators) OR MAX(COALESCE(json_extract(config_json,'$.at'),0),COALESCE(json_extract(sample_json,'$.at'),0))<? LIMIT 500)`,
    ).bind(cutoff),
    env.DB.prepare(
      "DELETE FROM regional_leases WHERE rowid IN (SELECT rowid FROM regional_leases WHERE reset<? LIMIT 500)",
    ).bind(cutoff),
  ]);
}
async function maintain(env: Env) {
  const now = Date.now();
  await pruneRoutingState(env, now);
  // Deployment-owned public endpoints are trusted admission configuration, not
  // a flag accepted through registration. Identity is rechecked on every refresh.
  for (const entry of configuredOperators(env)) {
    const id = (await hash(entry.url)).slice(0, 32),
      row: Registration = {
        ...entry,
        id,
        status: "offline",
        token: "",
        createdAt: now,
        checkedAt: 0,
        healthy: false,
      };
    await env.DB.prepare(
      `INSERT INTO operators(id,host,status,created_at,checked_at,last_attempt,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='offline',checked_at=0,data=json_set(operators.data,'$.status','offline','$.checkedAt',0) WHERE operators.status='pending'`,
    )
      .bind(
        id,
        new URL(entry.url).hostname,
        "offline",
        now,
        0,
        0,
        JSON.stringify(row),
      )
      .run();
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM operators WHERE status='pending' AND created_at<?",
    ).bind(now - 900000),
    env.DB.prepare("DELETE FROM limits WHERE reset<?").bind(now),
  ]);
  const rows = await env.DB.prepare(
    "SELECT id FROM operators WHERE status!='pending' AND COALESCE(json_extract(data,'$.verifiedAt'),0)<? ORDER BY COALESCE(json_extract(data,'$.verifiedAt'),0),id LIMIT ?",
  )
    .bind(now - 600000, positiveSetting(env, "MAINTENANCE_BATCH_SIZE", 100))
    .all<{ id: string }>();
  for (let i = 0; i < rows.results.length; i += 4)
    await Promise.all(
      rows.results.slice(i, i + 4).map(async ({ id }) => {
        const stored = await env.DB.prepare(
          "UPDATE operators SET last_attempt=? WHERE id=? AND last_attempt<? RETURNING data",
        )
          .bind(now, id, now - 60000)
          .first<StoredOperator>();
        if (stored)
          await check(env, JSON.parse(stored.data), true, now).catch(() => {});
      }),
    );
}
async function recordConfig(
  env: Env,
  origin: string,
  row: Operator,
  event: ConfigEvent,
) {
  const status = event.ok ? "active" : "offline";
  // Atomic predicate prevents a concurrent identity/ownership rejection from
  // being overwritten by a configuration-only health success.
  await env.DB.prepare(
    `UPDATE operators SET status=?,checked_at=?,data=json_set(data,
 '$.status',?,'$.healthy',json(?),'$.checkedAt',?,'$.price',
 CASE WHEN ? THEN json(?) ELSE json_extract(data,'$.price') END)
 WHERE id=? AND status IN ('active','offline')`,
  )
    .bind(
      status,
      event.at,
      status,
      event.ok ? "true" : "false",
      event.at,
      event.ok ? 1 : 0,
      JSON.stringify(
        (event.ok ? event.config.validation_config?.price : null) ?? null,
      ),
      row.id,
    )
    .run();
  // Successful refreshes do not evict the local routing snapshot.
  if (!event.ok) await caches.default.delete(new Request(origin + "/_pool"));
}
const refresh = (rows: Operator[], env: Env, origin: string, region: string) =>
  refreshRegional(
    rows.filter((row) => ["active", "offline"].includes(row.status)),
    env,
    origin,
    region,
    (row) => probeQuote(row, env.NEIRO_MINT),
    { onConfig: (row, event) => recordConfig(env, origin, row, event) },
  );
async function scheduledRefresh(env: Env) {
  await maintainIfDue(env);
  const origin =
    "https://" + (env.ROUTER_HOSTS || "router.invalid").split(",")[0];
  const stored = await env.DB.prepare(
    "SELECT data FROM operators WHERE status IN ('active','offline')",
  ).all<StoredOperator>();
  await refresh(
    stored.results.map((x) => JSON.parse(x.data) as Operator),
    env,
    origin,
    "SCHEDULED",
  );
}
async function maintainIfDue(env: Env) {
  const now = Date.now();
  const lease = await env.DB.prepare(
    `INSERT INTO regional_leases(id,n,reset) VALUES ('directory-maintenance',1,?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id`,
  )
    .bind(now + 60000, now)
    .first();
  if (lease) await maintain(env);
}
async function pool(env: ReadEnv, ctx: ExecutionContext, origin: string) {
  const key = new Request(origin + "/_pool"),
    refreshKey = new Request(origin + "/_pool-refresh");
  const configured = new Set(configuredOperators(env).map((row) => row.url));
  const fresh = (rows: Operator[]) =>
    rows.map((row) => ({
      ...row,
      configured: configured.has(row.url),
      healthy:
        row.status === "active" &&
        row.healthy === true &&
        row.checkedAt <= Date.now() &&
        row.checkedAt > Date.now() - 300000,
    }));
  const hit = await caches.default.match(key),
    previous = hit ? await hit.json<CachedRows<Operator>>() : null;
  const age = previous ? Date.now() - previous.at : Infinity;
  async function update() {
    const at = Date.now();
    const result = await env.DB.prepare(
      "SELECT data FROM operators WHERE status!='pending' AND json_extract(data,'$.payer') IS NOT NULL",
    ).all<StoredOperator>();
    const value = {
      at,
      rows: result.results.map((r) => {
        const { token, ...row } = JSON.parse(r.data) as Operator;
        return row;
      }),
    };
    await caches.default.put(
      key,
      Response.json(value, { headers: { "cache-control": "max-age=120" } }),
    );
    return value.rows;
  }
  if (age >= 0 && age < 60000) return fresh(previous!.rows);
  if (age >= 60000 && age < 120000) {
    ctx.waitUntil(
      (async () => {
        if (await caches.default.match(refreshKey)) return;
        await caches.default.put(
          refreshKey,
          new Response("1", { headers: { "cache-control": "max-age=5" } }),
        );
        await update();
      })().catch(() => {}),
    );
    return fresh(previous!.rows);
  }
  return fresh(await update());
}
function regionalCandidates(rows: Operator[], region: string) {
  const now = Date.now();
  return rows.map((row) => {
    const c = row.configStats,
      fresh =
        c?.region === region &&
        Number.isSafeInteger(c.at) &&
        c.at <= now &&
        now - c.at < 300000;
    return {
      ...row,
      healthy: row.healthy && row.failedUntil! <= now && !(fresh && c.failed),
      latencyMs:
        fresh &&
        typeof c.latencyMs === "number" &&
        Number.isFinite(c.latencyMs) &&
        c.latencyMs >= 0
          ? c.latencyMs
          : 1e9,
      price: row.price,
    };
  });
}
export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scheduledRefresh(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Routing snapshots tolerate bounded staleness. Admission and coordination
    // retain the primary binding; each request owns its read-only session.
    let readEnv: ReadEnv;
    const routingEnv = () =>
      (readEnv ??= { ...env, DB: env.DB.withSession("first-unconstrained") });
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    if (url.pathname === "/healthz")
      return json({
        ok: true,
        mode: "url-enrollment",
        colo: request.cf?.colo || "unknown",
      });
    if (
      !(
        await env.REQUEST_LIMIT.limit({
          key: request.headers.get("cf-connecting-ip") || "unknown",
        })
      ).success
    )
      return json({ error: "Request limit reached" }, 429);
    if (
      [
        "/operators/register",
        "/operators/verify",
        "/operators/remove",
      ].includes(url.pathname)
    ) {
      if (
        url.pathname !== "/operators/remove" &&
        env.ENROLLMENT_OPEN !== "true"
      )
        return json({ error: "Enrollment closed" }, 503);
      if (request.method !== "POST")
        return json({ error: "POST required" }, 405);
      try {
        const value = (await bodyJSON(request)) as {
          url?: unknown;
          id?: unknown;
        };
        const result = await enroll(
          url.pathname.split("/").at(-1)!,
          value,
          request.headers.get("cf-connecting-ip") || "unknown",
          env,
        );
        if (url.pathname !== "/operators/register")
          await Promise.all(
            ["/_pool", "/_pool-refresh"].map((path) =>
              caches.default.delete(new Request(url.origin + path)),
            ),
          );
        return result;
      } catch {
        return json({ error: "Invalid request" }, 400);
      }
    }
    if (url.pathname === "/operators" && request.method === "GET") {
      try {
        const region = request.cf?.colo || "unknown",
          baseRows = await pool(routingEnv(), ctx, url.origin);
        ctx.waitUntil(
          refresh(baseRows, env, url.origin, region).catch(() => {}),
        );
        const rows = regionalCandidates(
          await loadRegional(baseRows, routingEnv(), url.origin, region, ctx),
          region,
        );
        return json({
          colo: region,
          operators: rows.map((r) => ({
            id: r.id,
            payer: r.payer,
            eligible: !!r.healthy,
            latencyMs: r.latencyMs === 1e9 ? null : r.latencyMs,
            price: normalizePrice(r.price),
            submissionStats: r.submissionStats,
            quoteEwmaMs:
              r.quoteStats?.region === region &&
              r.quoteStats.at <= Date.now() &&
              Date.now() - r.quoteStats.at < 300000
                ? r.quoteStats.ewmaMs
                : null,
            sampleEwmaMs:
              r.sampleStats?.region === region &&
              r.sampleStats.at <= Date.now() &&
              Date.now() - r.sampleStats.at < 300000
                ? r.sampleStats.ewmaMs
                : null,
            checkedAt: r.checkedAt,
            sampleQuote: r.sampleQuote
              ? {
                  ...r.sampleQuote,
                  stale: Date.now() - r.sampleQuote.at > 660000,
                }
              : null,
          })),
        });
      } catch {
        return json({ error: "Directory unavailable" }, 503);
      }
    }
    if (url.pathname !== "/rpc") return json({ error: "Not found" }, 404);
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    let id: unknown = null;
    let chosen: Operator | undefined;
    let region = request.cf?.colo || "unknown",
      isQuote = false;
    let submissionBody: RpcRequest | undefined;
    let forwardStarted: number | undefined;
    try {
      if (request.headers.has("x-neiro-router-hop"))
        return json({ error: "Routing loop" }, 400);
      const raw = await bounded(
        request,
        positiveSetting(env, "MAX_RPC_BODY_BYTES", 1048576),
      );
      const body = JSON.parse(raw) as RpcRequest | RpcRequest[],
        batch = Array.isArray(body),
        calls = batch ? body : [body];
      if (
        !calls.length ||
        calls.some(
          (call) =>
            !call || call.jsonrpc !== "2.0" || typeof call.method !== "string",
        )
      )
        return json({ error: "Invalid JSON-RPC request" }, 400);
      id = batch ? null : ((body as RpcRequest).id ?? null);
      const baseRows = await pool(routingEnv(), ctx, url.origin);
      ctx.waitUntil(refresh(baseRows, env, url.origin, region).catch(() => {}));
      const rows = regionalCandidates(
        await loadRegional(baseRows, routingEnv(), url.origin, region, ctx),
        region,
      );
      const queryPayer = url.searchParams.get("provider") || undefined,
        operatorId = url.searchParams.get("operator") || undefined;
      const pins: unknown[] = [queryPayer];
      let unknownTransaction = false;
      for (const call of calls) {
        const params = call.params;
        if (params && typeof params === "object" && !Array.isArray(params)) {
          if (params.signer_key !== undefined) pins.push(params.signer_key);
          for (const transaction of [
            params.transaction,
            ...(Array.isArray(params.transactions) ? params.transactions : []),
          ]) {
            if (typeof transaction !== "string") continue;
            const payer = transactionPayer(transaction);
            if (payer) pins.push(payer);
            else unknownTransaction = true;
          }
        }
      }
      const specified = pins.filter((value) => value !== undefined);
      if (new Set(specified).size > 1)
        return json(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Conflicting provider or transaction payer",
            },
          },
          400,
        );
      if (unknownTransaction && !specified.length && !operatorId)
        return json(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message:
                "Specify provider or operator for an unrecognized transaction encoding; it will be forwarded unchanged",
            },
          },
          400,
        );
      const mode = url.searchParams.get("selection") || "fastest",
        priceGroup = url.searchParams.get("priceGroup") || undefined;
      // Exclude locally observed failures before sending anything upstream.
      // Usually one cache read; explicit pins still fail instead of switching payer.
      for (let attempt = 0; attempt <= rows.length; attempt++) {
        chosen = selectOperator(rows, {
          mode,
          payer: specified[0],
          operatorId,
          priceGroup,
          region,
        });
        if (
          (await localFailureUntil(url.origin, region, chosen.id)) <= Date.now()
        )
          break;
        rows.find((row) => row.id === chosen!.id)!.healthy = false;
        chosen = undefined;
      }
      isQuote =
        !batch && (body as RpcRequest).method === "estimateTransactionFee";
      submissionBody = submissionRequest(body) ? body : undefined;
      forwardStarted = Date.now();
      if (!chosen) throw Error("Selected provider unavailable");
      const result = await forward(
        chosen.url,
        raw,
        positiveSetting(env, "UPSTREAM_TIMEOUT_MS", 30000),
        positiveSetting(env, "MAX_RPC_RESPONSE_BYTES", 1048576),
      );
      const responseValue = result.value as RpcEnvelope | undefined;
      if (submissionBody)
        ctx.waitUntil(
          noteSubmission(chosen, env, url.origin, region, {
            ok:
              result.status >= 200 &&
              result.status < 300 &&
              submissionSuccess(submissionBody, result.value),
            ms: result.ms,
          }).catch(() => {}),
        );
      if (!isQuote && (result.status >= 500 || result.status === 429))
        ctx.waitUntil(
          noteQuote(chosen, env, url.origin, region, {
            ok: false,
            kind: "transport",
          }).catch(() => {}),
        );
      if (isQuote)
        ctx.waitUntil(
          noteQuote(chosen, env, url.origin, region, {
            ok:
              result.status >= 200 &&
              result.status < 300 &&
              !!responseValue?.result &&
              !responseValue.error,
            ms: result.ms,
            kind:
              result.status >= 500 || result.status === 429
                ? "transport"
                : responseValue?.error
                  ? "business"
                  : "traffic",
          }).catch(() => {}),
        );
      const q = chosen.sampleStats,
        routing = {
          provider: chosen.payer,
          providerId: chosen.id,
          upstreamMs: result.ms,
          colo: region,
          selection: chosen.selectionBasis || "pinned",
          advertisedPrice: normalizePrice(chosen.price),
          latencySource: chosen.latencyBasis || "cold-start",
          submissionStats: chosen.submissionStats ?? null,
          quoteEwmaMs:
            chosen.latencyBasis === "regional-sample-quote-ewma"
              ? q?.ewmaMs
              : null,
          configMs: chosen.latencyMs === 1e9 ? null : chosen.latencyMs,
          configEwmaMs: chosen.configStats?.ewmaMs ?? null,
        };
      // Raw upstream response preserves all numbers, errors and transaction bytes.
      return new Response(result.text || null, {
        status: result.status,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "x-neiro-routing",
          "cache-control": "no-store",
          "x-neiro-routing": JSON.stringify(routing),
        },
      });
    } catch (e) {
      if (chosen && submissionBody && forwardStarted !== undefined)
        ctx.waitUntil(
          noteSubmission(chosen, env, url.origin, region, {
            ok: false,
            ms: Date.now() - forwardStarted,
          }).catch(() => {}),
        );
      if (chosen)
        ctx.waitUntil(
          noteQuote(chosen, env, url.origin, region, {
            ok: false,
            kind: "transport",
          }).catch(() => {}),
        );
      const selectionErrors = [
        "Incomparable advertised pricing; specify priceGroup",
        "Invalid selection options",
        "Selected payer is ambiguous; pin operator ID",
        "Incomparable sample quotes",
        "Incomparable regional sample quotes",
      ];
      return json(
        {
          jsonrpc: "2.0",
          id,
          error: {
            code: selectionErrors.includes((e as Error).message)
              ? -32602
              : -32001,
            message: selectionErrors.includes((e as Error).message)
              ? (e as Error).message
              : "Provider unavailable; requests are never automatically resubmitted",
          },
        },
        selectionErrors.includes((e as Error).message) ? 400 : 503,
      );
    }
  },
} satisfies ExportedHandler<Env>;
