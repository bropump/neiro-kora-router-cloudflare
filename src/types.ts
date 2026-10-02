/** Types for router-owned state. Network JSON remains untrusted at runtime. */
export interface Settings {
  ACTIVITY_RPC_URL?: string;
  ENROLLMENT_OPEN?: string;
  NEIRO_MINT: string;
  ROUTER_HOSTS?: string;
  CONFIGURED_OPERATORS?: string;
  ADMISSION_REQUESTS_PER_IP_HOUR?: string;
  MAINTENANCE_BATCH_SIZE?: string;
  CONFIG_CHECK_CONCURRENCY?: string;
  REGIONAL_CONFIG_BATCH_SIZE?: string;
  MAX_RPC_BODY_BYTES?: string;
  MAX_RPC_RESPONSE_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}
export interface Env extends Settings {
  DB: D1Database;
  REQUEST_LIMIT: RateLimit;
}
export interface ReadEnv extends Settings {
  DB: Pick<D1Database, "prepare">;
}
export type OperatorStatus =
  "pending" | "active" | "offline" | "disabled" | "removed";
export interface Registration {
  hostingRegions?: string[];
  id: string;
  url: string;
  token?: string;
  status: OperatorStatus;
  createdAt: number;
  checkedAt: number;
  verifiedAt?: number;
  identityBoundAt?: number;
  payer?: string;
  paymentAddress?: string;
  healthy?: boolean;
  latencyMs?: number;
  price?: unknown;
}
export interface Operator extends Registration {
  payer: string;
  paymentAddress: string;
  configured?: boolean;
  failedUntil?: number;
  sampleQuote?: Sample | null;
  sampleStats?: Sample | null;
  submissionStats?: SubmissionStats | null;
  quoteStats?: QuoteStats | null;
  configStats?: ConfigStats | null;
  selectionBasis?: string;
  latencyBasis?: string;
}
export interface ConfiguredOperator {
  hostingRegions?: string[];
  url: string;
  payer: string;
  paymentAddress: string;
}
export interface Sample {
  ok: boolean;
  at: number;
  region: string;
  template: string;
  mint: string;
  feeInToken?: number;
  feeInLamports?: number;
  ms?: number;
  ewmaMs?: number | null;
  samples?: number;
  kind?: string;
}
export interface ConfigStats {
  at: number;
  region: string;
  price?: unknown;
  latencyMs: number | null;
  ewmaMs?: number;
  failed?: boolean;
}
export interface QuoteStats {
  at: number;
  region: string;
  ewmaMs: number;
  samples: number;
  source: "probe" | "traffic";
}
export interface SubmissionEvent {
  at: number;
  ms: number;
  ok: boolean;
}
export interface SubmissionSummary {
  firstAt: number;
  at: number;
  ageMs: number;
  samples: number;
  successes: number;
  failures: number;
  successRate: number;
  meanMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
}
export interface SubmissionStats extends SubmissionSummary {
  region: string;
  method: "signAndSendTransaction";
  respondAfter: "sent";
  retentionMs: number;
  stale: boolean;
  routing: (SubmissionSummary & { windowMs: number }) | null;
}
export interface RegionalRow {
  operator_id: string;
  config_json?: string | null;
  sample_json?: string | null;
  quote_json?: string | null;
  submission_json?: string | null;
  failed_until?: number;
  last_probe_at?: number;
}
export interface StoredOperator {
  data: string;
}
export interface CachedRows<T> {
  at: number;
  rows: T[];
}
export interface RpcEnvelope<T = Record<string, unknown>> {
  jsonrpc?: unknown;
  id?: unknown;
  result?: T;
  error?: unknown;
}
export interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown> | unknown[] | null;
}
export interface KoraConfig {
  fee_payers?: unknown;
  enabled_methods?: Record<string, unknown>;
  validation_config?: { allowed_spl_paid_tokens?: string[]; price?: unknown };
}
export interface KoraIdentity {
  signer_address?: unknown;
  payment_address?: unknown;
}
export type ProbeResult =
  | {
      ok: true;
      kind: "probe";
      ms: number;
      feeInToken: number;
      feeInLamports: number;
    }
  | { ok: false; kind: "business" | "protocol" | "transport" };
export interface QuoteEvent {
  ok: boolean;
  kind: string;
  ms?: number;
}
export type ConfigEvent =
  | { ok: true; config: KoraConfig; ms: number; at: number }
  | { ok: false; kind: string; at: number };
export type NormalizedPrice =
  | { type: "free"; group: "free"; value: 0 }
  | { type: "margin"; group: "margin"; value: number; margin: number }
  | {
      type: "fixed";
      group: string;
      value: string;
      amount: string;
      token: string;
      strict: boolean;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
