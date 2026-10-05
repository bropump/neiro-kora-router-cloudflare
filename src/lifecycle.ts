import type { Operator, Registration, Settings } from "./types.js";

export const OWNERSHIP_MAX_AGE_MS = 20 * 60_000;
export const ARCHIVE_AFTER_MS = 24 * 60 * 60_000;
export function fresh(at: unknown, now: number, age: number): at is number {
  return (
    typeof at === "number" &&
    Number.isSafeInteger(at) &&
    at > 0 &&
    at <= now &&
    now - at < age
  );
}
export function boundedSetting(
  env: Settings,
  key: keyof Settings,
  fallback: number,
  max: number,
) {
  const n = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw Error("Invalid " + key);
  return n;
}
export function ownershipFresh(row: Registration, now = Date.now()) {
  return fresh(row.verifiedAt, now, OWNERSHIP_MAX_AGE_MS);
}
export function lifecycleFailure(
  row: Registration,
  reason: string,
  now: number,
) {
  const offlineSince =
    typeof row.offlineSince === "number" &&
    row.offlineSince > 0 &&
    row.offlineSince <= now
      ? row.offlineSince
      : now;
  const failures = Math.min((row.failures || 0) + 1, 16);
  return {
    offlineSince,
    failures,
    failureReason: reason,
    nextCheckAt: now + Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1)),
  };
}
export function shouldArchive(row: Registration, now = Date.now()) {
  return (
    ["offline", "disabled"].includes(row.status) &&
    typeof row.offlineSince === "number" &&
    row.offlineSince > 0 &&
    now - row.offlineSince >= ARCHIVE_AFTER_MS
  );
}
export function publicOperators(rows: Operator[], includeInactive: boolean) {
  return includeInactive ? rows : rows.filter((row) => row.healthy);
}
