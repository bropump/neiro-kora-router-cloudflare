import { isRecord } from "./types.js";
import type { NormalizedPrice, Operator, Sample } from "./types.js";
import { usableSubmission } from "./submission.js";
// Cached equivalent samples or advertised prices are estimates, never a guarantee of the lowest final payment.
const U64_MAX = 18446744073709551615n;
const validLatency = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fresh = (at: unknown, now: number, age: number) =>
  validTime(at) && at <= now && now - at < age;

export function normalizePrice(raw: unknown): NormalizedPrice | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "free") return { type: "free", group: "free", value: 0 };
  if (
    raw.type === "margin" &&
    typeof raw.margin === "number" &&
    Number.isFinite(raw.margin) &&
    raw.margin >= 0 &&
    raw.margin <= Number.MAX_SAFE_INTEGER
  ) {
    return {
      type: "margin",
      group: "margin",
      value: raw.margin,
      margin: raw.margin,
    };
  }
  if (
    raw.type !== "fixed" ||
    typeof raw.token !== "string" ||
    !raw.token ||
    typeof raw.strict !== "boolean"
  )
    return null;
  const amount = raw.amount;
  if (
    !(
      typeof amount === "number" &&
      Number.isSafeInteger(amount) &&
      amount >= 0
    ) &&
    !(typeof amount === "string" && /^(0|[1-9][0-9]{0,19})$/.test(amount))
  )
    return null;
  const units = BigInt(amount);
  if (units > U64_MAX) return null;
  return {
    type: "fixed",
    group: `fixed:${raw.token}:${raw.strict}`,
    value: units.toString(),
    amount: units.toString(),
    token: raw.token,
    strict: raw.strict,
  };
}

export function selectOperator(
  rows: Operator[],
  {
    mode = "fastest",
    payer,
    operatorId,
    priceGroup,
    region,
    now = Date.now(),
    healthMaxAgeMs = 300000,
    quoteMaxAgeMs = 300000,
    sampleMaxAgeMs = 660000,
  }: {
    mode?: string;
    payer?: unknown;
    operatorId?: string;
    priceGroup?: string;
    region?: string;
    now?: number;
    healthMaxAgeMs?: number;
    quoteMaxAgeMs?: number;
    sampleMaxAgeMs?: number;
  } = {},
) {
  if (
    !["fastest", "cheapest"].includes(mode) ||
    !validTime(now) ||
    ![healthMaxAgeMs, quoteMaxAgeMs, sampleMaxAgeMs].every(
      (x) => validLatency(x) && x > 0,
    )
  )
    throw Error("Invalid selection options");
  const eligible = (row: Operator) =>
    row.healthy === true &&
    typeof row.id === "string" &&
    row.id &&
    fresh(row.checkedAt, now, healthMaxAgeMs);
  // Reported payer identity is not a cryptographic ownership proof. Preserve
  // the first verified binding so a later duplicate cannot disable/displace it.
  // Configured endpoints take priority; explicit operator IDs can select a
  // deliberate alternative without silently failing over signed transactions.
  const boundAt = (row: Operator) =>
    validTime(row.identityBoundAt)
      ? row.identityBoundAt
      : validTime(row.createdAt)
        ? row.createdAt
        : 0;
  const bindings = new Map<string, Operator>();
  for (const row of [...rows].sort(
    (a, b) =>
      Number(!!b.configured) - Number(!!a.configured) ||
      boundAt(a) - boundAt(b) ||
      a.id.localeCompare(b.id),
  )) {
    if (!bindings.has(row.payer)) bindings.set(row.payer, row);
  }
  let candidates: Operator[];
  if (operatorId !== undefined) {
    candidates = rows.filter(
      (row) =>
        row.id === operatorId &&
        (payer === undefined || row.payer === payer) &&
        eligible(row),
    );
    if (candidates.length !== 1) throw Error("Selected provider unavailable");
    return { ...candidates[0], selectionBasis: "pinned" };
  }
  candidates = [...bindings.values()].filter(eligible);
  if (payer !== undefined) {
    const chosen = candidates.find((row) => row.payer === payer);
    if (!chosen) throw Error("Selected provider unavailable");
    return { ...chosen, selectionBasis: "pinned" };
  }
  if (priceGroup !== undefined && mode === "cheapest")
    candidates = candidates.filter(
      (row) => normalizePrice(row.price)?.group === priceGroup,
    );
  // Background samples compare the same workload. Customer quotes can contain
  // unrelated transfers/swaps and must not change this ranking.
  const group = (value: Sample) => JSON.stringify([value.template, value.mint]);
  const identified = (value: Sample | null | undefined) =>
    typeof value?.template === "string" &&
    !!value.template &&
    typeof value.mint === "string" &&
    !!value.mint;
  const regionalSample = (row: Operator) =>
    row.sampleStats?.ok === true &&
    identified(row.sampleStats) &&
    row.sampleStats.region === region &&
    fresh(row.sampleStats.at, now, quoteMaxAgeMs) &&
    validLatency(row.sampleStats.ewmaMs) &&
    Number.isSafeInteger(row.sampleStats.samples) &&
    row.sampleStats.samples! > 0;
  const measured = candidates.filter(regionalSample);
  const comparableLatency =
    measured.length > 0 &&
    new Set(measured.map((row) => group(row.sampleStats!))).size === 1;
  if (mode === "fastest" && measured.length && !comparableLatency)
    throw Error("Incomparable regional sample quotes");
  const configLatency = (row: Operator) =>
    row.configStats &&
    !row.configStats.failed &&
    row.configStats?.region === region &&
    fresh(row.configStats.at, now, healthMaxAgeMs) &&
    validLatency(row.configStats.latencyMs)
      ? validLatency(row.configStats.ewmaMs)
        ? row.configStats.ewmaMs
        : row.configStats.latencyMs
      : Infinity;
  const submissionReady =
    candidates.length > 0 &&
    candidates.every((row) =>
      usableSubmission(row.submissionStats, region!, now),
    );
  const latency = (row: Operator): number =>
    submissionReady
      ? row.submissionStats!.routing!.medianMs!
      : comparableLatency
        ? regionalSample(row)
          ? row.sampleStats!.ewmaMs!
          : Infinity
        : configLatency(row);
  const coldOrder = new Map(candidates.map((row) => [row.id, Math.random()]));
  const compareLatency = (a: Operator, b: Operator) =>
    (latency(a) === latency(b) ? 0 : latency(a) < latency(b) ? -1 : 1) ||
    (!Number.isFinite(latency(a))
      ? coldOrder.get(a.id)! - coldOrder.get(b.id)!
      : 0) ||
    a.id.localeCompare(b.id);
  let selectionBasis = submissionReady
    ? "regional sampled submission median"
    : comparableLatency
      ? "regional equivalent sample quote latency"
      : "regional configuration latency";
  if (mode === "cheapest") {
    const sample = (row: Operator) => row.sampleQuote;
    const usable = (row: Operator) =>
      sample(row)?.ok === true &&
      fresh(sample(row)!.at, now, sampleMaxAgeMs) &&
      identified(sample(row)) &&
      Number.isSafeInteger(sample(row)!.feeInToken) &&
      sample(row)!.feeInToken! >= 0;
    const quoted = candidates.filter(usable);
    if (quoted.length) {
      if (new Set(quoted.map((row) => group(sample(row)!))).size !== 1)
        throw Error("Incomparable sample quotes");
      candidates = quoted;
      candidates.sort(
        (a, b) =>
          sample(a)!.feeInToken! - sample(b)!.feeInToken! ||
          compareLatency(a, b),
      );
      selectionBasis = "lowest fresh comparable sample quote";
    } else {
      let priced = candidates
        .map((row) => ({ row, price: normalizePrice(row.price) }))
        .filter(
          (entry): entry is { row: Operator; price: NormalizedPrice } =>
            entry.price !== null,
        );
      const free = priced.filter((entry) => entry.price.type === "free");
      if (free.length) priced = free;
      else if (new Set(priced.map((entry) => entry.price.group)).size > 1)
        throw Error("Incomparable advertised pricing; specify priceGroup");
      priced.sort((a, b) => {
        const av =
          a.price.type === "fixed" ? BigInt(a.price.value) : a.price.value;
        const bv =
          b.price.type === "fixed" ? BigInt(b.price.value) : b.price.value;
        return (av < bv ? -1 : av > bv ? 1 : 0) || compareLatency(a.row, b.row);
      });
      candidates = priced.map((entry) => entry.row);
      selectionBasis = "lowest comparable advertised rate";
    }
  } else candidates.sort(compareLatency);
  if (!candidates.length)
    throw Error("No healthy provider with comparable pricing or latency");
  const chosen = candidates[0];
  return {
    ...chosen,
    selectionBasis,
    latencyBasis: submissionReady
      ? "regional-submission-median"
      : comparableLatency && regionalSample(chosen)
        ? "regional-sample-quote-ewma"
        : !comparableLatency && Number.isFinite(configLatency(chosen))
          ? "regional-config"
          : "cold-start",
  };
}
