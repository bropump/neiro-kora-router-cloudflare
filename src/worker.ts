import type {
  CachedRows,
  ConfigEvent,
  Env,
  Operator,
  ReadEnv,
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
import { bounded, json } from "./policy.js";
import { forward } from "./upstream.js";
import {
  syncDirectory,
  listingFresh,
  listingConfigMatches,
} from "./directory.js";
import { selectOperator, normalizePrice } from "./selection.js";
import {
  loadRegional,
  noteQuote,
  refreshRegional,
  localFailureUntil,
} from "./regional.js";
import { probeQuote, transactionPayer } from "./probe.js";
import { fundingExclusion, fundingScope, refreshFunding } from "./readiness.js";
import { publicOperators } from "./lifecycle.js";
function positiveSetting(env: Settings, key: keyof Settings, fallback: number) {
  const n = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw Error("Invalid " + key);
  return n;
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
      `DELETE FROM regional_stats WHERE rowid IN (SELECT rowid FROM regional_stats WHERE failed_until<=? AND (operator_id NOT IN (SELECT id FROM operators WHERE status!='archived') OR last_probe_at=0 AND MAX(COALESCE(json_extract(config_json,'$.at'),0),COALESCE(json_extract(quote_json,'$.at'),0),COALESCE(json_extract(sample_json,'$.at'),0))<? AND COALESCE(json_extract(submission_json,'$[#-1].at'),0)<=?) LIMIT 500)`,
    ).bind(now, cutoff, now - SUBMISSION_MAX_AGE_MS),
    env.DB.prepare(
      `DELETE FROM operator_observations WHERE rowid IN (SELECT rowid FROM operator_observations WHERE operator_id NOT IN (SELECT id FROM operators) OR MAX(COALESCE(json_extract(config_json,'$.at'),0),COALESCE(json_extract(sample_json,'$.at'),0))<? LIMIT 500)`,
    ).bind(cutoff),
    env.DB.prepare(
      "DELETE FROM regional_leases WHERE rowid IN (SELECT rowid FROM regional_leases WHERE reset<? LIMIT 500)",
    ).bind(cutoff),
  ]);
}
export async function recordConfig(
  env: Env,
  origin: string,
  row: Operator,
  event: ConfigEvent,
) {
  const current = await env.DB.prepare("SELECT data FROM operators WHERE id=?")
    .bind(row.id)
    .first<StoredOperator>();
  if (!current) return;
  row = JSON.parse(current.data) as Operator;
  const exclusion = event.ok
    ? fundingExclusion(row, await fundingScope(env)) ||
      (!listingFresh(row) ? "listing-expired-or-unchecked" : null) ||
      (!listingConfigMatches(row, event.config)
        ? "listing-config-mismatch"
        : null)
    : "kora-config-unavailable";
  const ready = event.ok && !exclusion;
  const status = ready ? "active" : "offline";
  // Atomic predicate prevents a concurrent identity/ownership rejection from
  // being overwritten by a configuration-only health success.
  await env.DB.prepare(
    `UPDATE operators SET status=?,checked_at=?,data=json_set(data,
 '$.status',?,'$.healthy',json(?),'$.checkedAt',?,'$.price',
 CASE WHEN ? THEN json(?) ELSE json_extract(data,'$.price') END,
 '$.enabledMethods',CASE WHEN ? THEN json(?) ELSE json_extract(data,'$.enabledMethods') END,
 '$.lastSuccessfulAt',CASE WHEN ? THEN ? ELSE json_extract(data,'$.lastSuccessfulAt') END,
 '$.offlineSince',CASE WHEN ? THEN NULL ELSE COALESCE(json_extract(data,'$.offlineSince'),?) END,
 '$.failureReason',?)
 WHERE id=? AND status IN ('active','offline') AND checked_at<=? AND COALESCE(json_extract(data,'$.listing.checkedAt'),0)=? AND COALESCE(json_extract(data,'$.funding.at'),0)=?`,
  )
    .bind(
      status,
      event.at,
      status,
      ready ? "true" : "false",
      event.at,
      event.ok ? 1 : 0,
      JSON.stringify(
        (event.ok ? event.config.validation_config?.price : null) ?? null,
      ),
      event.ok ? 1 : 0,
      JSON.stringify(event.ok ? event.config.enabled_methods : {}),
      ready ? 1 : 0,
      event.at,
      ready ? 1 : 0,
      event.at,
      exclusion,
      row.id,
      event.at,
      row.listing?.checkedAt || 0,
      row.funding?.at || 0,
    )
    .run();
  // Successful refreshes do not evict the local routing snapshot.
  if (!ready)
    await caches.default.delete(new Request(origin + "/_pool-onchain-v1"));
}
const refresh = (rows: Operator[], env: Env, origin: string, region: string) =>
  refreshRegional(
    rows.filter(
      (row) => listingFresh(row) && ["active", "offline"].includes(row.status),
    ),
    env,
    origin,
    region,
    (row) => probeQuote(row, env.NEIRO_MINT),
    { onConfig: (row, event) => recordConfig(env, origin, row, event) },
  );
async function scheduledRefresh(env: Env) {
  await syncDirectory(env);
  await refreshFunding(env);
  await pruneRoutingState(env);
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
async function pool(env: ReadEnv, ctx: ExecutionContext, origin: string) {
  const key = new Request(origin + "/_pool-onchain-v1"),
    refreshKey = new Request(origin + "/_pool-onchain-refresh-v1");
  const fresh = (rows: Operator[]) =>
    rows.map((row) => ({
      ...row,
      healthy:
        row.status === "active" &&
        row.healthy === true &&
        listingFresh(row) &&
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
        return JSON.parse(r.data) as Operator;
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
function regionalCandidates(rows: Operator[], region: string, scope: string) {
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
      healthy:
        row.healthy &&
        listingFresh(row, now) &&
        !fundingExclusion(row, scope, now) &&
        row.failedUntil! <= now &&
        !(fresh && c.failed),
      failureReason:
        row.status === "archived"
          ? "archived-after-prolonged-outage"
          : !listingFresh(row, now)
            ? "listing-expired-or-unchecked"
            : fundingExclusion(row, scope, now) ||
              (fresh && c.failed
                ? "local-config-check-failed"
                : row.failureReason),
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
        mode: "onchain-discovery",
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
          await fundingScope(env),
        );
        return json({
          measurementColo: region,
          operators: publicOperators(
            rows,
            url.searchParams.get("includeInactive") === "true",
          ).map((r) => ({
            id: r.id,
            payer: r.payer,
            listing: r.listing,
            enabledMethods: r.enabledMethods,
            eligible: !!r.healthy,
            status: r.status,
            lastSuccessfulAt: r.lastSuccessfulAt ?? null,
            offlineSince: r.offlineSince ?? null,
            failureReason: r.healthy
              ? null
              : (r.failureReason ?? "health-stale-or-unavailable"),
            archivedAt: r.archivedAt ?? null,
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
        await fundingScope(env),
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
      // Match only known signing capabilities; all other JSON-RPC methods pass through.
      const required = calls.flatMap((call) => {
        if (call.method === "signTransaction") return ["sign_transaction"];
        if (call.method === "signAndSendTransaction")
          return ["sign_and_send_transaction"];
        return [];
      });
      for (const row of rows)
        if (required.some((method) => row.enabledMethods?.[method] !== true))
          row.healthy = false;
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
