import { isRecord } from "./types.js";
import type { Operator, RpcRequest } from "./types.js";
import { PreferenceError, unsignedAmount } from "./preferences.js";

export function checkQuoteRequest(
  body: RpcRequest | RpcRequest[],
  cap: string | undefined,
  mint: string,
) {
  if (cap === undefined) return;
  if (
    Array.isArray(body) ||
    body.method !== "estimateTransactionFee" ||
    !isRecord(body.params) ||
    body.params.fee_token !== mint ||
    !(typeof body.id === "string" || Number.isSafeInteger(body.id))
  )
    throw new PreferenceError(
      "maxFeeNeiroRaw requires one estimateTransactionFee request with an ID and explicit NEIRO fee_token; it does not apply to signing or submission",
    );
}
export interface QuoteFailure {
  message: string;
  status: number;
  code: number;
}
// These are response consistency checks, not pricing math or transaction verification.
// A Kora quote does not echo its token mint; the requested fee_token is the unit
// context. We cannot independently prove the token conversion from this response.
export function checkQuotes(
  body: RpcRequest | RpcRequest[],
  response: unknown,
  row: Operator,
  cap?: string,
): QuoteFailure | null {
  // Preserve arbitrary batches unchanged. A batch may already have submitted a
  // payment before a quote is returned; do not hide its responses behind a new error.
  // Explicit caps reject batches before forwarding (checkQuoteRequest).
  if (Array.isArray(body) || body.method !== "estimateTransactionFee")
    return null;
  const calls = [body];
  const quotes = calls;
  const invalid = (): QuoteFailure => ({
    status: 502,
    code: -32002,
    message: "Operator quote failed identity or response checks",
  });
  const replies = [response];
  for (const call of quotes) {
    if (call.id === undefined) continue; // Notifications have no quote response to validate.
    if (calls.filter((c) => c.id === call.id).length !== 1) return invalid();
    const matches = replies.filter((r) => isRecord(r) && r.id === call.id);
    if (matches.length !== 1 || !isRecord(matches[0])) return invalid();
    const reply = matches[0];
    if (reply.jsonrpc !== "2.0") return invalid();
    if (Object.hasOwn(reply, "error") && !Object.hasOwn(reply, "result"))
      continue; // Preserve Kora's own error unchanged.
    if (Object.hasOwn(reply, "error") || !isRecord(reply.result))
      return invalid();
    const quote = reply.result;
    if (
      quote.signer_pubkey !== row.payer ||
      quote.payment_address !== row.paymentAddress ||
      unsignedAmount(quote.fee_in_lamports) === null
    )
      return invalid();
    const token = isRecord(call.params) ? call.params.fee_token : undefined;
    const amount = unsignedAmount(quote.fee_in_token);
    if (token !== undefined && (typeof token !== "string" || amount === null))
      return invalid();
    if (quote.fee_in_token != null && amount === null) return invalid();
    if (Object.hasOwn(quote, "fee_token") && quote.fee_token !== token)
      return invalid();
    if (cap !== undefined && (amount === null || amount > BigInt(cap)))
      return {
        status: 422,
        code: -32003,
        message: "Operator quote exceeds maxFeeNeiroRaw",
      };
  }
  return null;
}
