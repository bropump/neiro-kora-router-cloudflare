import type { Operator, Settings } from "./types.js";

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
export function publicOperators(rows: Operator[], includeInactive: boolean) {
  return includeInactive ? rows : rows.filter((row) => row.healthy);
}
