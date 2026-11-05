# Operations

## Discovery and trust

The router uses NPN's signed v5 `NEIRO069` SPL Record listings on Solana mainnet.
The vendored verifier checks the record authority, derived address, signature,
network, mint and finalized anchor. Listings expire after 48 chain hours.
A completed shared discovery runs every five minutes. Failed RPC refreshes keep
previous evidence without renewing it; eligibility expires after 15 minutes or
the signed listing deadline, whichever comes first. Complete scans remove closed,
invalid or expired records. Endpoint/price/payment changes reset measurements.

The Solana RPC is used only in background discovery and funding checks, not for
forwarding a customer's Kora request. A cold cache may read D1; it does not scan
Solana. Public mainnet RPC is a fallback, not a capacity promise.
No wallet credentials are stored. Operator URLs must be public HTTPS hostnames,
without credentials, query strings or redirects. Do not bind private/VPC fetch
to this Worker. A valid listing proves signed terms, not honest server execution.

## Selection and costs

Cloudflare's serving colo supplies the regional label; it is not a measurement
of the user's location or user-to-edge latency. Each active colo checks a rotating
batch of at most 12 operators, concurrency two, with a three-minute per-operator
interval. The minute cron provides shared health/prices and recovery. Each sample
calls `getBlockhash` then `estimateTransactionFee` directly on Kora; Kora may in
turn call its own Solana RPC. Samples are unsigned and have no instructions.

Fastest prefers comparable regional sample-quote EWMA, or config latency when
samples are absent. Passive `signAndSendTransaction` acknowledgements with explicit
`respond_after: "sent"` can supply a median after every candidate has five recent
successful samples and at least 90% sampled success. This is not landing latency.
Cheapest ranks sample NEIRO fees (11-minute maximum age), or comparable advertised
rates when no fresh samples exist. Mixed rates may need `priceGroup`. Actual
payment quotes and client fee limits remain authoritative.

The router admits either signing method and selects a capable operator for known
signing requests. Explicit provider/transaction payer pins cannot silently switch.
Other JSON-RPC methods pass through without an allowlist. New requests can select
another available operator; already-forwarded requests are never replayed.

## Bounds and storage

- Per-IP ingress: 50 requests / 10 seconds (Workers local rate limiting, not global quota).
- Request/response body: 1 MiB; upstream timeout: 30 seconds; no retries.
- Local routing caches: 60 seconds fresh, up to 120 seconds while refreshing.
  Empty regional snapshots refresh after five seconds; completed local probes evict
  their regional snapshot immediately.
- Config/latency eligibility: five minutes; discovery evidence: 15 minutes.
- Funding: up to 50 oldest operators per minute, batches of 25; three-minute freshness.
- Discovery RPC response: 8 MiB; eight-second request timeout; signed anchors deduplicated.
- Submission diagnostics: at most 32 samples / provider / colo, retained seven days;
  only samples within one hour affect ranking. At most one sampled write / 10 seconds.
- Expired measurements and coordination leases are pruned in batches of 500.

These conservative background bounds suit a small network. At larger sizes,
measure refresh coverage before raising them: 1,000 synthetic rows are a bounded
work test, not proof that every row stays fresh or that 1,000 live operators work.
D1 stores public listings, funding evidence and bounded timing data, not customer
transactions or transaction signatures. Regional reads use D1 Sessions and local
Workers Cache API. Use `GET /operators?includeInactive=true` to diagnose exclusions.

## Simple selection and quote preferences

`GET /select?selection=fastest&maxMarkupBps=500&method=signTransaction`
returns the chosen identity, pricing, sample age data, listing expiry, `rpcUrl`
and `quoteUrl`. Both URLs pin the operator; reuse `rpcUrl` for ordinary Kora calls.
The same markup/method filters work on `/rpc`, including pinned calls. No match
returns 503; preferences are never silently relaxed. `maxMarkupBps=500` means 5%:
free operators qualify, percentage prices must be <=5%, and fixed fees are excluded
because they cannot be compared to a percentage without transaction costs.

Optional `maxFeeNeiroRaw=5000000` means 5 NEIRO (six decimal places). On `/select`
it is carried into `quoteUrl`, not enforced against a sample price and not added
to `rpcUrl`. On `/rpc` it is accepted only for a single `estimateTransactionFee`
request with an ID and explicit NEIRO `fee_token`. Other methods or batches with
a cap are rejected before forwarding; a signing response cannot enforce a fee
cap after submission. Use an unsigned transaction when requesting a quote.

Single quote responses are checked for JSON-RPC ID, selected signer, published
payment address and valid nonnegative integer fee amounts. When present, a returned
fee-token field must match the requested token. Standard Kora quotes do not echo
the mint: its unit context comes from the request, not an independent conversion
proof. Safe integer numbers and decimal u64 strings are supported; imprecise numeric
amounts are rejected. A cap breach returns 422, malformed/mismatched quote 502,
invalid options 400. Kora's own errors and accepted responses remain unchanged.
Neither rejection retries another operator. Arbitrary uncapped batches retain
passthrough behaviour without per-quote checking; do not mix quote checking with
payment submission. Notifications provide no response to verify.

These checks do not calculate prices, lock quotes, inspect reimbursement instructions,
verify arbitrary programs or enforce final onchain charges. The client must verify
the transaction and fee before signing. Kora retains its own signing policy.
