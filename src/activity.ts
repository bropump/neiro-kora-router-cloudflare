import type { Env, ReadEnv } from "./types.js";
import { isRecord } from "./types.js";
import { bounded } from "./policy.js";
import { boundedSetting } from "./lifecycle.js";

// Only acknowledged send operations are countable. Sign-only responses,
// notifications, ambiguous batch IDs, transport failures and RPC errors are not.
export function acknowledgedSignatures(
  request: unknown,
  response: unknown,
): string[] {
  const requests = Array.isArray(request) ? request : [request];
  const responses = Array.isArray(response) ? response : [response];
  const out = new Set<string>();
  const requestCounts = new Map<unknown, number>(),
    responseById = new Map<unknown, unknown[]>();
  for (const q of requests)
    if (isRecord(q))
      requestCounts.set(q.id, (requestCounts.get(q.id) || 0) + 1);
  for (const r of responses)
    if (isRecord(r)) {
      const list = responseById.get(r.id) || [];
      list.push(r);
      responseById.set(r.id, list);
    }
  for (const q of requests) {
    if (
      !isRecord(q) ||
      q.jsonrpc !== "2.0" ||
      q.method !== "signAndSendTransaction" ||
      !(
        typeof q.id === "string" ||
        (typeof q.id === "number" && Number.isFinite(q.id))
      )
    )
      continue;
    if (requestCounts.get(q.id) !== 1) continue;
    if (q.params !== undefined && !isRecord(q.params)) continue;
    const mode = isRecord(q.params) ? q.params.respond_after : undefined;
    if (mode !== undefined && mode !== "sent" && mode !== "confirmed") continue;
    const matches = responseById.get(q.id) || [];
    if (matches.length !== 1) continue;
    const r = matches[0];
    if (
      !isRecord(r) ||
      r.jsonrpc !== "2.0" ||
      Object.hasOwn(r, "error") ||
      !isRecord(r.result)
    )
      continue;
    const signature = r.result.signature;
    if (
      typeof signature === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)
    )
      out.add(signature);
  }
  return [...out];
}
export async function recordActivity(
  env: Env,
  operator: string,
  signatures: string[],
) {
  const now = Date.now();
  // Bound each D1 batch without truncating the received signature list.
  for (let i = 0; i < signatures.length; i += 50)
    await env.DB.batch(
      signatures
        .slice(i, i + 50)
        .map((signature) =>
          env.DB.prepare(
            "INSERT OR IGNORE INTO network_transactions(signature,operator_id,submitted_at,next_check_at) SELECT ?,?,?,? WHERE (SELECT COALESCE(SUM(count),0) FROM network_activity_counts)<100000",
          ).bind(signature, operator, now, now),
        ),
    );
}
export async function activityFeed(env: ReadEnv) {
  const [meta, counts, recent] = await Promise.all([
    env.DB.prepare(
      "SELECT started_at FROM network_activity_meta WHERE id=1",
    ).first<{ started_at: number }>(),
    env.DB.prepare("SELECT status,count FROM network_activity_counts").all<{
      status: string;
      count: number;
    }>(),
    env.DB.prepare(
      "SELECT signature,operator_id AS operatorId,submitted_at AS submittedAt,status,checked_at AS checkedAt,slot FROM network_transactions ORDER BY submitted_at DESC,signature LIMIT 50",
    ).all(),
  ]);
  return {
    startedAt: meta?.started_at ?? null,
    counts: counts.results,
    recent: recent.results,
    retentionDays: boundedSetting(env, "ACTIVITY_RETENTION_DAYS", 7, 30),
    capacity: 100000,
    trackingSaturated:
      (counts.results || []).reduce((sum, x) => sum + x.count, 0) >= 100000,
  };
}
export async function signatureStatuses(
  signatures: string[],
  endpoint: string,
) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [signatures, { searchTransactionHistory: true }],
    }),
    // Workers supports manual redirects; reject non-success responses below.
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error("Signature status RPC HTTP " + r.status);
  const j: unknown = JSON.parse(await bounded(r, 262144));
  if (
    !isRecord(j) ||
    j.id !== 1 ||
    j.error ||
    !isRecord(j.result) ||
    !Array.isArray(j.result.value) ||
    j.result.value.length !== signatures.length
  )
    throw Error("Invalid signature status response");
  return j.result.value as unknown[];
}
export function chainState(
  value: unknown,
): { status: string; slot: number } | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.slot) ||
    Number(value.slot) < 0
  )
    return null;
  // Wait for confirmed commitment before treating an on-chain error as final evidence.
  if (
    value.confirmationStatus !== "confirmed" &&
    value.confirmationStatus !== "finalized"
  )
    return null;
  if (!Object.hasOwn(value, "err")) return null;
  return {
    status: value.err !== null ? "failed" : value.confirmationStatus,
    slot: Number(value.slot),
  };
}
async function reconcileBatch(env: Env) {
  const now = Date.now();
  const rows = (
    await env.DB.prepare(
      "SELECT signature,submitted_at FROM network_transactions WHERE status IN ('submitted','confirmed') AND next_check_at<=? ORDER BY next_check_at LIMIT 100",
    )
      .bind(now)
      .all<{ signature: string; submitted_at: number }>()
  ).results;
  if (!rows.length) return false;
  // Lease this bounded batch before calling RPC; overlapping cron invocations do not
  // change terminal statuses. A failed RPC leaves records pending for a later retry.
  await env.DB.prepare(
    "UPDATE network_transactions SET next_check_at=? WHERE signature IN (SELECT value FROM json_each(?))",
  )
    .bind(now + 60000, JSON.stringify(rows.map((r) => r.signature)))
    .run();
  const statuses = await signatureStatuses(
    rows.map((r) => r.signature),
    env.ACTIVITY_RPC_URL || "https://api.mainnet-beta.solana.com",
  );
  const updates = rows.map((r, i) => {
    const chain = chainState(statuses[i]);
    const status =
      chain?.status || (now - r.submitted_at > 86400000 ? "unknown" : null);
    return { signature: r.signature, status, slot: chain?.slot ?? null };
  });
  await env.DB.prepare(
    `UPDATE network_transactions SET
    status=COALESCE((SELECT json_extract(value,'$.status') FROM json_each(?) WHERE json_extract(value,'$.signature')=network_transactions.signature),status),
    slot=COALESCE((SELECT json_extract(value,'$.slot') FROM json_each(?) WHERE json_extract(value,'$.signature')=network_transactions.signature),slot),checked_at=?
    WHERE signature IN (SELECT json_extract(value,'$.signature') FROM json_each(?)) AND status IN ('submitted','confirmed')`,
  )
    .bind(
      JSON.stringify(updates),
      JSON.stringify(updates),
      now,
      JSON.stringify(updates),
    )
    .run();
  return true;
}
export async function reconcileActivity(env: Env) {
  const now = Date.now();
  const lease = await env.DB.prepare(
    "INSERT INTO regional_leases(id,n,reset) VALUES ('activity-reconcile',1,?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id",
  )
    .bind(now + 60000, now)
    .first();
  if (!lease) return;
  const cutoff =
    now - boundedSetting(env, "ACTIVITY_RETENTION_DAYS", 7, 30) * 86400000;
  await env.DB.prepare(
    "DELETE FROM network_transactions WHERE signature IN (SELECT signature FROM network_transactions WHERE submitted_at<? ORDER BY submitted_at LIMIT 1000)",
  )
    .bind(cutoff)
    .run();
  // Also converge databases created before the cap was introduced. Keep each
  // cleanup bounded even if historical telemetry contains millions of rows.
  await env.DB.prepare(
    "DELETE FROM network_transactions WHERE signature IN (SELECT signature FROM network_transactions ORDER BY submitted_at LIMIT MIN(1000,MAX(0,(SELECT COALESCE(SUM(count),0)-100000 FROM network_activity_counts))))",
  ).run();
  for (
    let i = 0;
    i < boundedSetting(env, "ACTIVITY_CHECK_BATCHES", 4, 8) &&
    Date.now() - now < 40000;
    i++
  )
    if (!(await reconcileBatch(env))) break;
}
