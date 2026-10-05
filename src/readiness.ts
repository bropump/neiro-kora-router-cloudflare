import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/addresses";
import { bounded } from "./policy.js";
import { fresh } from "./lifecycle.js";
import { isRecord } from "./types.js";
import type { Env, Operator, Registration, Settings } from "./types.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const FUNDING_MAX_AGE_MS = 180_000;
export interface Funding {
  at: number;
  slot: number;
  scope: string;
  payer: string;
  paymentAddress: string;
  ata: string;
  lamports: number;
  ready: boolean;
  reason: string | null;
}
const endpoint = (env: Settings) =>
  env.FUNDING_RPC_URL || "https://api.mainnet-beta.solana.com";
export async function fundingScope(env: Settings) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([endpoint(env), env.NEIRO_MINT, MAINNET_GENESIS]),
    ),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function associatedAddress(owner: string, mint: string) {
  const encode = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [
      encode.encode(address(owner)),
      encode.encode(address(TOKEN_PROGRAM)),
      encode.encode(address(mint)),
    ],
  });
  return ata;
}
async function rpc(
  env: Settings,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await fetch(endpoint(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error("funding-rpc-unavailable");
  const value: unknown = JSON.parse(await bounded(response, 262144));
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    value.id !== 1 ||
    Object.hasOwn(value, "error") ||
    !Object.hasOwn(value, "result")
  )
    throw Error("funding-rpc-unavailable");
  return value.result;
}
function bytes(account: Record<string, unknown>) {
  if (
    !Array.isArray(account.data) ||
    account.data[1] !== "base64" ||
    typeof account.data[0] !== "string"
  )
    throw Error("invalid-account-data");
  return Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0));
}
function lamports(account: Record<string, unknown>) {
  if (!Number.isSafeInteger(account.lamports) || Number(account.lamports) < 0)
    throw Error("invalid-account-balance");
  return Number(account.lamports);
}
export function decodeFunding(
  payerAccount: unknown,
  ataAccount: unknown,
  row: Registration,
  mint: string,
  ata: string,
  rent: number,
  slot: number,
  scope: string,
  now = Date.now(),
): Funding {
  const state: Funding = {
    at: now,
    slot,
    scope,
    payer: row.payer!,
    paymentAddress: row.paymentAddress!,
    ata,
    lamports: 0,
    ready: false,
    reason: null,
  };
  try {
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      !Number.isSafeInteger(rent) ||
      rent <= 0
    )
      throw Error("invalid-chain-evidence");
    if (
      !isRecord(payerAccount) ||
      payerAccount.owner !== "11111111111111111111111111111111" ||
      payerAccount.executable !== false ||
      bytes(payerAccount).length !== 0
    )
      throw Error("invalid-sol-payer");
    state.lamports = lamports(payerAccount);
    if (!isRecord(ataAccount)) throw Error("neiro-ata-missing");
    if (ataAccount.owner !== TOKEN_PROGRAM || ataAccount.executable !== false)
      throw Error("neiro-ata-program");
    const data = bytes(ataAccount),
      encode = getAddressEncoder();
    if (
      data.length !== 165 ||
      !encode.encode(address(mint)).every((b, i) => data[i] === b) ||
      !encode
        .encode(address(row.paymentAddress!))
        .every((b, i) => data[i + 32] === b)
    )
      throw Error("neiro-ata-identity");
    if (data[108] !== 1) throw Error("neiro-ata-not-initialized-or-frozen");
    if (lamports(ataAccount) < rent) throw Error("neiro-ata-not-rent-exempt");
    state.ready = true;
  } catch (error) {
    state.reason =
      error instanceof Error ? error.message : "funding-check-failed";
  }
  return state;
}
export function fundingExclusion(
  row: Operator,
  scope: string,
  now = Date.now(),
): string | null {
  const f = row.funding;
  if (
    !f ||
    f.scope !== scope ||
    f.payer !== row.payer ||
    f.paymentAddress !== row.paymentAddress ||
    !fresh(f.at, now, FUNDING_MAX_AGE_MS)
  )
    return "funding-stale-or-unchecked";
  if (!f.ready || f.reason) return f.reason || "funding-check-failed";
  const sample = row.sampleQuote;
  const floor =
    sample?.ok &&
    fresh(sample.at, now, 660000) &&
    Number.isSafeInteger(sample.feeInLamports) &&
    sample.feeInLamports! >= 0
      ? Math.max(5000, sample.feeInLamports!)
      : 5000;
  return f.lamports < floor ? "insufficient-sol" : null;
}
// One prelude and one account RPC per <=25 operators. Never signs or creates accounts.
export async function checkFunding(
  env: Settings,
  rows: Registration[],
  now = Date.now(),
): Promise<Funding[]> {
  if (!rows.length) return [];
  if (rows.length > 25) throw Error("Funding batch exceeds 25 operators");
  const scope = await fundingScope(env);
  const atas = await Promise.all(
    rows.map(async (row) => {
      try {
        address(row.payer!);
        return await associatedAddress(row.paymentAddress!, env.NEIRO_MINT);
      } catch {
        return null;
      }
    }),
  );
  if (atas.some((ata) => ata === null)) {
    const valid = await checkFunding(
      env,
      rows.filter((_, i) => atas[i] !== null),
      now,
    );
    let next = 0;
    return rows.map((row, i) =>
      atas[i] === null
        ? {
            at: now,
            slot: 0,
            scope,
            payer: row.payer!,
            paymentAddress: row.paymentAddress!,
            ata: "",
            lamports: 0,
            ready: false,
            reason: "invalid-operator-address",
          }
        : valid[next++],
    );
  }
  try {
    const [genesis, rent] = await Promise.all([
      rpc(env, "getGenesisHash"),
      rpc(env, "getMinimumBalanceForRentExemption", [
        165,
        { commitment: "confirmed" },
      ]),
    ]);
    if (
      genesis !== MAINNET_GENESIS ||
      !Number.isSafeInteger(rent) ||
      Number(rent) <= 0
    )
      throw Error("funding-network-or-rent");
    const previous = rows
      .map((row) => row.funding)
      .filter(
        (f) =>
          f?.scope === scope && Number.isSafeInteger(f.slot) && f.slot >= 0,
      );
    const minContextSlot = Math.max(0, ...previous.map((f) => f!.slot));
    const result = await rpc(env, "getMultipleAccounts", [
      rows.flatMap((row, i) => [row.payer!, atas[i]]),
      { encoding: "base64", commitment: "confirmed", minContextSlot },
    ]);
    if (
      !isRecord(result) ||
      !isRecord(result.context) ||
      !Number.isSafeInteger(result.context.slot) ||
      Number(result.context.slot) < minContextSlot ||
      !Array.isArray(result.value) ||
      result.value.length !== rows.length * 2
    )
      throw Error("funding-account-response");
    const values = result.value,
      slot = Number(result.context.slot);
    return rows.map((row, i) =>
      decodeFunding(
        values[i * 2],
        values[i * 2 + 1],
        row,
        env.NEIRO_MINT,
        atas[i]!,
        Number(rent),
        slot,
        scope,
        now,
      ),
    );
  } catch {
    return rows.map((row, i) => ({
      at: now,
      slot: row.funding?.scope === scope ? row.funding.slot : 0,
      scope,
      payer: row.payer!,
      paymentAddress: row.paymentAddress!,
      ata: atas[i]!,
      lamports: 0,
      ready: false,
      reason: "funding-check-failed",
    }));
  }
}
export async function refreshFunding(env: Env) {
  const now = Date.now();
  const claimed = await env.DB.prepare(
    "INSERT INTO regional_leases(id,n,reset) VALUES ('funding-refresh',1,?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id",
  )
    .bind(now + 60000, now)
    .first();
  if (!claimed) return;
  const rows = (
    await env.DB.prepare(
      "SELECT data FROM operators WHERE status IN ('active','offline') AND json_extract(data,'$.payer') IS NOT NULL ORDER BY COALESCE(json_extract(data,'$.funding.at'),0),id LIMIT 50",
    ).all<{ data: string }>()
  ).results.map((x) => JSON.parse(x.data) as Registration);
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25),
      states = await checkFunding(env, batch);
    await env.DB.batch(
      states.map((state, j) =>
        env.DB.prepare(
          "UPDATE operators SET data=json_set(data,'$.funding',json(?)) WHERE id=? AND json_extract(data,'$.payer')=? AND json_extract(data,'$.paymentAddress')=? AND status IN ('active','offline') AND COALESCE(json_extract(data,'$.funding.at'),0)<=?",
        ).bind(
          JSON.stringify(state),
          batch[j].id,
          state.payer,
          state.paymentAddress,
          state.at,
        ),
      ),
    );
  }
}
