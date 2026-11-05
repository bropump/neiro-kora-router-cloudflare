import { normalizePrice } from "./selection.js";
import type { Operator } from "./types.js";

export class PreferenceError extends Error {}
export interface Preferences {
  maxMarkupBps?: number;
  method?: string;
  maxFeeNeiroRaw?: string;
}
export function unsignedAmount(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
  } else if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    return null;
  const n = BigInt(value);
  return n <= 18446744073709551615n ? n : null;
}
export function preferences(params: URLSearchParams): Preferences {
  for (const name of [
    "selection",
    "provider",
    "operator",
    "priceGroup",
    "maxMarkupBps",
    "method",
    "maxFeeNeiroRaw",
  ])
    if (params.getAll(name).length > 1)
      throw new PreferenceError("Duplicate selection preference: " + name);
  const result: Preferences = {};
  if (params.has("maxMarkupBps")) {
    const raw = params.get("maxMarkupBps")!;
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      throw new PreferenceError("maxMarkupBps must be a nonnegative integer");
    result.maxMarkupBps = Number(raw);
  }
  if (params.has("method")) {
    const method = params.get("method")!;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(method))
      throw new PreferenceError("Invalid required method");
    result.method = method;
  }
  if (params.has("maxFeeNeiroRaw")) {
    const raw = params.get("maxFeeNeiroRaw")!;
    if (unsignedAmount(raw) === null)
      throw new PreferenceError(
        "maxFeeNeiroRaw must be an unsigned integer string (NEIRO base units)",
      );
    result.maxFeeNeiroRaw = raw;
  }
  return result;
}
export function matchesPreferences(row: Operator, options: Preferences) {
  if (options.method) {
    const key = options.method
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    if (row.enabledMethods?.[key] !== true) return false;
  }
  if (options.maxMarkupBps !== undefined) {
    const p = normalizePrice(row.price);
    // Fixed charges cannot be converted to a percentage without actual costs.
    if (
      !p ||
      (p.type !== "free" &&
        (p.type !== "margin" || p.margin > options.maxMarkupBps / 10000))
    )
      return false;
  }
  return true;
}
