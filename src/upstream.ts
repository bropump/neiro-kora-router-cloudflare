import type {
  KoraConfig,
  KoraIdentity,
  Registration,
  RpcEnvelope,
} from "./types.js";
import { bounded, configCheck } from "./policy.js";
// Cloudflare global fetch only: no VPC bindings, credentials, cookies or caller headers.
// Private networking must never be bound to this deployment. Redirects are forbidden.
export async function upstream<T = Record<string, unknown>>(
  url: string,
  method: string,
  params: unknown = {},
  timeout = 8000,
) {
  const start = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-neiro-router-hop": "1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Error("Kora unavailable");
  const value = JSON.parse(await bounded(response)) as RpcEnvelope<T>;
  if (
    value.jsonrpc !== "2.0" ||
    value.id !== 1 ||
    (!("result" in value) && !value.error)
  )
    throw Error("Invalid Kora response");
  return { value, ms: Date.now() - start };
}
export async function inspect(url: string, mint: string) {
  const identity = await upstream<KoraIdentity>(url, "getPayerSigner");
  const config = await upstream<KoraConfig>(url, "getConfig");
  return {
    ...configCheck(config.value.result, identity.value.result, mint),
    latencyMs: config.ms,
    price: config.value.result!.validation_config!.price,
    checkedAt: Date.now(),
    healthy: true,
  };
}
export async function ownership(row: Registration) {
  const u = new URL(row.url);
  u.pathname = "/.well-known/neiro-router/" + row.id;
  u.search = "";
  const response = await fetch(u, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw Error("Ownership proof unavailable");
  const proof = JSON.parse(await bounded(response, 1024)) as {
    token?: unknown;
    enabled?: unknown;
  };
  if (proof.token !== row.token || typeof proof.enabled !== "boolean")
    throw Error("Ownership proof mismatch");
  return proof.enabled;
}

// Customer JSON is forwarded exactly as received, including transaction strings,
// IDs and parameters. The router does not add signer_key or rewrite transactions.
export async function forward(
  url: string,
  raw: string,
  timeout = 30000,
  maxResponseBytes = 1048576,
) {
  const start = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-neiro-router-hop": "1" },
    body: raw,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  if (response.status >= 300 && response.status < 400)
    throw Error("Upstream redirect rejected");
  const text = response.body ? await bounded(response, maxResponseBytes) : "";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {}
  return { value, text, status: response.status, ms: Date.now() - start };
}
