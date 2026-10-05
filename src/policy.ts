import type { KoraConfig, KoraIdentity } from "./types.js";
import { assertIsAddress } from "@solana/addresses";
export const REQUIRED = [
  "get_config",
  "get_payer_signer",
  "estimate_transaction_fee",
  "sign_transaction",
  "sign_and_send_transaction",
];
export function endpoint(raw: unknown, ownHosts: string[] = []) {
  if (typeof raw !== "string" || raw.length > 256 || raw.trim() !== raw)
    throw Error("Invalid endpoint");
  const u = new URL(raw),
    h = u.hostname;
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !h.includes(".") ||
    h.endsWith(".") ||
    !/[a-z]/i.test(h) ||
    !/^[a-z0-9.-]+$/.test(h) ||
    h.split(".").some((x) => !x || x.startsWith("-") || x.endsWith("-")) ||
    /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(h) ||
    ownHosts.includes(h)
  )
    throw Error("Public HTTPS hostname required");
  return u.href;
}
export async function bounded(response: Request | Response, max = 65536) {
  if (!response.body) throw Error("Empty response");
  const r = response.body.getReader();
  let n = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const v = await r.read();
      if (v.done) break;
      n += v.value.length;
      if (n > max) throw Error("Body limit");
      chunks.push(v.value);
    }
  } catch (e) {
    await r.cancel();
    throw e;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(out);
}
export async function bodyJSON(req: Request, max = 2048): Promise<unknown> {
  return JSON.parse(await bounded(req, max));
}
export function configCheck(
  config: KoraConfig | undefined,
  identity: KoraIdentity | undefined,
  mint: string,
) {
  if (
    !config ||
    !identity ||
    !Array.isArray(config.fee_payers) ||
    !config.fee_payers.includes(identity.signer_address) ||
    typeof identity.payment_address !== "string"
  )
    throw Error("Kora identity unavailable");
  for (const key of ["signer_address", "payment_address"] as const)
    if (
      typeof identity[key] !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identity[key])
    )
      throw Error("Invalid address");
  assertIsAddress(identity.signer_address as string);
  assertIsAddress(identity.payment_address as string);
  for (const m of REQUIRED)
    if (config.enabled_methods?.[m] !== true)
      throw Error("Kora methods unavailable");
  if (!config.validation_config?.allowed_spl_paid_tokens?.includes(mint))
    throw Error("Required payment token unavailable");
  return {
    payer: identity.signer_address as string,
    paymentAddress: identity.payment_address,
  };
}
export const json = (v: unknown, status = 200) =>
  Response.json(v, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
