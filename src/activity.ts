import type { Env, ReadEnv } from "./types.js";
import { isRecord } from "./types.js";
import { bounded } from "./policy.js";

// Only acknowledged send operations are countable. Sign-only responses,
// notifications, ambiguous batch IDs, transport failures and RPC errors are not.
export function acknowledgedSignatures(
  request: unknown,
  response: unknown,
): string[] {
  const requests = Array.isArray(request) ? request : [request];
  const responses = Array.isArray(response) ? response : [response];
  const out = new Set<string>();
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
    if (requests.filter((x) => isRecord(x) && x.id === q.id).length !== 1)
      continue;
    if (q.params !== undefined && !isRecord(q.params)) continue;
    const mode = isRecord(q.params) ? q.params.respond_after : undefined;
    if (mode !== undefined && mode !== "sent" && mode !== "confirmed") continue;
    const matches = responses.filter((r) => isRecord(r) && r.id === q.id);
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
            "INSERT OR IGNORE INTO network_transactions(signature,operator_id,submitted_at,next_check_at) VALUES (?,?,?,?)",
          ).bind(signature, operator, now, now),
        ),
    );
}
export async function activityFeed(env: ReadEnv) {
  const [meta, counts, recent] = await Promise.all([
    env.DB.prepare(
      "SELECT started_at FROM network_activity_meta WHERE id=1",
    ).first<{ started_at: number }>(),
    env.DB.prepare(
      "SELECT status,COUNT(*) AS count FROM network_transactions GROUP BY status",
    ).all<{ status: string; count: number }>(),
    env.DB.prepare(
      "SELECT signature,operator_id AS operatorId,submitted_at AS submittedAt,status,checked_at AS checkedAt,slot FROM network_transactions ORDER BY submitted_at DESC,signature LIMIT 50",
    ).all(),
  ]);
  return {
    startedAt: meta?.started_at ?? null,
    counts: counts.results,
    recent: recent.results,
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
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Error("Signature status RPC unavailable");
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
export async function reconcileActivity(env: Env) {
  const now = Date.now();
  const rows = (
    await env.DB.prepare(
      "SELECT signature,submitted_at FROM network_transactions WHERE status IN ('submitted','confirmed') AND next_check_at<=? ORDER BY next_check_at LIMIT 100",
    )
      .bind(now)
      .all<{ signature: string; submitted_at: number }>()
  ).results;
  if (!rows.length) return;
  // Lease this bounded batch before calling RPC; overlapping cron invocations do not
  // change terminal statuses. A failed RPC leaves records pending for a later retry.
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        "UPDATE network_transactions SET next_check_at=? WHERE signature=?",
      ).bind(now + 60000, r.signature),
    ),
  );
  const statuses = await signatureStatuses(
    rows.map((r) => r.signature),
    env.ACTIVITY_RPC_URL || "https://api.mainnet-beta.solana.com",
  );
  await env.DB.batch(
    rows.map((r, i) => {
      const chain = chainState(statuses[i]);
      const status =
        chain?.status || (now - r.submitted_at > 86400000 ? "unknown" : null);
      return env.DB.prepare(
        "UPDATE network_transactions SET status=COALESCE(?,status),slot=COALESCE(?,slot),checked_at=? WHERE signature=? AND status IN ('submitted','confirmed')",
      ).bind(status, chain?.slot ?? null, now, r.signature);
    }),
  );
}
