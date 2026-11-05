import { Buffer } from "node:buffer";
import { PROGRAM, MAGIC, MINT, readRecord } from "./listing/read-record.mjs";
import { bounded, endpoint } from "./policy.js";
import { MAINNET_GENESIS } from "./readiness.js";
import { normalizePrice } from "./selection.js";
import { isRecord } from "./types.js";
import type { Env, KoraConfig, Registration, Settings } from "./types.js";

// One shared scan every five minutes; cached eligibility expires after fifteen.
// The signed listing itself expires 48 hours after its finalized chain anchor.
export const DIRECTORY_INTERVAL_MS = 300_000;
export const DIRECTORY_MAX_AGE_MS = 900_000;
export function listingFresh(row: Registration, now = Date.now()) {
  const value = row.listing;
  return (
    !!value &&
    value.checkedAt <= now &&
    now - value.checkedAt < DIRECTORY_MAX_AGE_MS &&
    value.expiresAt > now
  );
}
export function listingConfigMatches(row: Registration, config: KoraConfig) {
  const terms = row.listing?.terms;
  return (
    !!terms &&
    Array.isArray(config.fee_payers) &&
    config.fee_payers.includes(row.payer) &&
    JSON.stringify(normalizePrice(terms.price)) ===
      JSON.stringify(normalizePrice(config.validation_config?.price)) &&
    config.validation_config?.price_source === terms.oracle
  );
}
export async function chainRpc(
  env: Settings,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await fetch(
    env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw Error("directory-rpc-unavailable");
  const value: unknown = JSON.parse(await bounded(response, 8 * 1024 * 1024));
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    value.id !== 1 ||
    "error" in value ||
    !("result" in value)
  )
    throw Error("directory-rpc-invalid");
  return value.result;
}
type Rpc = (method: string, params?: unknown[]) => Promise<unknown>;
export async function discover(
  env: Settings,
  rpc: Rpc = (m, p) => chainRpc(env, m, p),
  now = Date.now(),
) {
  if (
    env.NEIRO_MINT !== MINT ||
    (await rpc("getGenesisHash")) !== MAINNET_GENESIS
  )
    throw Error("directory-network-mismatch");
  const scan = await rpc("getProgramAccounts", [
    PROGRAM,
    {
      commitment: "finalized",
      encoding: "base64",
      withContext: true,
      filters: [
        { dataSize: 733 },
        {
          memcmp: {
            offset: 33,
            bytes: Buffer.from(MAGIC).toString("base64"),
            encoding: "base64",
          },
        },
      ],
    },
  ]);
  if (
    !isRecord(scan) ||
    !isRecord(scan.context) ||
    !Number.isSafeInteger(scan.context.slot) ||
    !Array.isArray(scan.value)
  )
    throw Error("directory-scan-invalid");
  const slot = Number(scan.context.slot);
  const clock = await rpc("getAccountInfo", [
    "SysvarC1ock11111111111111111111111111111111",
    { commitment: "finalized", encoding: "base64", minContextSlot: slot },
  ]);
  if (
    !isRecord(clock) ||
    !isRecord(clock.context) ||
    !Number.isSafeInteger(clock.context.slot) ||
    Number(clock.context.slot) < slot ||
    !isRecord(clock.value)
  )
    throw Error("directory-clock-invalid");
  const account = clock.value;
  if (
    account.owner !== "Sysvar1111111111111111111111111111111111111" ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data[1] !== "base64"
  )
    throw Error("directory-clock-invalid");
  const bytes = Buffer.from(String(account.data[0]), "base64");
  if (
    bytes.length !== 40 ||
    bytes.readBigUInt64LE() < BigInt(slot) ||
    bytes.readBigUInt64LE() > BigInt(Number(clock.context.slot))
  )
    throw Error("directory-clock-invalid");
  const chainTime = Number(bytes.readBigInt64LE(32));
  if (
    !Number.isSafeInteger(chainTime) ||
    Math.abs(chainTime * 1000 - now) > 120_000
  )
    throw Error("directory-clock-stale");
  const anchors = new Map<number, { hash: string; time: number }>();
  const rows: Registration[] = [];
  let rejected = 0;
  // Sequential anchor reads deduplicate shared slots and avoid RPC bursts. No
  // remote endpoint is contacted until its signed listing has been verified.
  for (const candidate of scan.value) {
    let preliminary: Record<string, unknown>;
    try {
      if (
        !isRecord(candidate) ||
        typeof candidate.pubkey !== "string" ||
        !isRecord(candidate.account)
      )
        throw Error("record");
      const a = candidate.account;
      if (!Array.isArray(a.data) || typeof a.data[0] !== "string")
        throw Error("record");
      const data = Buffer.from(a.data[0], "base64");
      if (data.length !== 733) throw Error("record-size");
      const size = data.readUInt16LE(41);
      if (!size || 43 + size + 64 > data.length) throw Error("record-body");
      const body: unknown = JSON.parse(data.subarray(43, 43 + size).toString());
      if (
        !isRecord(body) ||
        !Number.isSafeInteger(body.anchor_slot) ||
        Number(body.anchor_slot) > slot
      )
        throw Error("record-anchor");
      // Preliminary signature/schema validation only. Zero time is not trusted
      // freshness evidence; readRecord is called again with finalized data below.
      preliminary = readRecord(candidate.pubkey, a, MAINNET_GENESIS, {
        nowUnixSeconds: 0,
        anchorSlot: Number(body.anchor_slot),
        anchorBlockhash: String(body.anchor_blockhash),
        anchorBlockTime: 0,
      });
      endpoint(preliminary.url, (env.ROUTER_HOSTS || "").split(","));
    } catch {
      rejected++;
      continue;
    }
    const anchorSlot = Number(preliminary.anchor_slot);
    if (!anchors.has(anchorSlot)) {
      // A failed RPC makes the refresh incomplete: preserve the previous snapshot
      // until its freshness deadline rather than deleting unseen operators.
      const block = await rpc("getBlock", [
        anchorSlot,
        {
          commitment: "finalized",
          transactionDetails: "none",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ]);
      if (block === null) {
        rejected++;
        continue;
      }
      if (
        !isRecord(block) ||
        typeof block.blockhash !== "string" ||
        !Number.isSafeInteger(block.blockTime)
      )
        throw Error("directory-anchor-unavailable");
      anchors.set(anchorSlot, {
        hash: block.blockhash,
        time: Number(block.blockTime),
      });
    }
    try {
      const c = candidate as { pubkey: string; account: unknown };
      const anchor = anchors.get(anchorSlot)!;
      const terms = readRecord(c.pubkey, c.account, MAINNET_GENESIS, {
        nowUnixSeconds: chainTime,
        anchorSlot,
        anchorBlockhash: anchor.hash,
        anchorBlockTime: anchor.time,
      });
      const url = endpoint(terms.url, (env.ROUTER_HOSTS || "").split(","));
      // A changed endpoint or pricing/identity gets new measurements; an ordinary
      // renewal retains the routing history for unchanged terms.
      const identity = JSON.stringify([
        c.pubkey,
        url,
        terms.operator,
        terms.payment,
        normalizePrice(terms.price),
        terms.oracle,
      ]);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(identity),
      );
      const id = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      )
        .join("")
        .slice(0, 32);
      rows.push({
        id,
        url,
        payer: String(terms.operator),
        paymentAddress: String(terms.payment),
        price: terms.price,
        createdAt: now,
        checkedAt: 0,
        status: "offline",
        healthy: false,
        listing: {
          record: c.pubkey,
          anchorSlot,
          checkedAt: now,
          expiresAt: now + (anchor.time + 172800 - chainTime) * 1000,
          terms,
        },
      });
    } catch {
      rejected++;
    }
  }
  return { rows, scanned: scan.value.length, rejected };
}
export async function syncDirectory(env: Env) {
  const now = Date.now();
  const lease = await env.DB.prepare(
    "INSERT INTO regional_leases(id,n,reset) VALUES ('onchain-directory',1,?) ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id",
  )
    .bind(now + DIRECTORY_INTERVAL_MS, now)
    .first();
  if (!lease) return;
  try {
    const result = await discover(env);
    const statements = result.rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO operators(id,host,status,created_at,checked_at,last_attempt,data) VALUES (?,?,?,?,0,0,?)
      ON CONFLICT(id) DO UPDATE SET data=json_set(operators.data,'$.listing',json(?))`,
      ).bind(
        row.id,
        new URL(row.url).hostname,
        row.status,
        now,
        JSON.stringify(row),
        JSON.stringify(row.listing),
      ),
    );
    // D1 batch is transactional: never publish a half-updated discovery snapshot.
    statements.push(
      env.DB.prepare(
        "DELETE FROM operators WHERE COALESCE(json_extract(data,'$.listing.checkedAt'),0)<?",
      ).bind(now),
    );
    await env.DB.batch(statements);
    console.log("directory_refresh", {
      scanned: result.scanned,
      accepted: result.rows.length,
      rejected: result.rejected,
    });
  } catch {
    console.error("directory_refresh_failed");
    // Back off to the next minute; existing evidence is never re-dated on errors.
    await env.DB.prepare(
      "UPDATE regional_leases SET reset=? WHERE id='onchain-directory'",
    )
      .bind(Date.now() + 60000)
      .run();
  }
}
