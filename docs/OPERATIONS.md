# Routing and operating reference

[Back to setup](../README.md)

## Routing and compatibility

Use `/rpc?selection=fastest` (the default) or `/rpc?selection=cheapest` as the ordinary Kora client endpoint.

Fastest (also the default Auto behavior) compares fresh EWMA timings of the same background fee-estimate sample from the serving Cloudflare colo. Measured candidates rank ahead of unknown candidates; one missing observation cannot downgrade everyone. When no sample timing is available, local configuration-response timing is a labelled fallback. Entirely cold selection is provisional with randomized ties. When every eligible candidate has sufficient recent passive submission evidence (described below), fastest instead uses successful submission median. Otherwise the equivalent-sample ranking remains the fallback.

Cheapest compares fresh sample amounts for the same template and payment mint among measured candidates, using regional sample latency to break ties. Unmeasured providers remain in the background rotation. When no usable sample amounts exist, it falls back to advertised comparable prices. Mixed sample templates/mints cannot be compared. Mixed paid fixed-fee/markup groups require an explicit `priceGroup`, such as `margin` or `fixed:<mint>:<strict>`; URL-encode it. `priceGroup` restricts the candidate group before sample comparison.

Samples are unsigned empty transactions, not representative transfer, swap or account-creation quotes. The cheapest sample or advertised markup is **not a guarantee of the lowest final NEIRO payment**. Token conversion, rent, transaction complexity and operator configuration can change the final amount. Kora supplies the actual transaction quote; the merchant must check it before signing. The router does not implement pricing, simulation, sponsorship policy or wallet-balance validation. Eligibility alone does not prove the provider can fund every payment.

`getPayerSigner` selects an operator during preparation. Recognized transaction encodings are inspected only to obtain the payer for routing; the router does not validate or rebuild the transaction. Explicit `provider`, `operator` and `signer_key` pins must agree. The earliest verified binding for a payer remains the default, with deployment-configured endpoints taking priority. A newly registered duplicate cannot displace or disable that binding; use an explicit operator ID to choose an alternative. An offline primary is not silently replaced. This is continuity policy, not cryptographic proof of wallet possession. Payer changes require removal and re-registration. Unknown transaction encodings require an explicit provider/operator pin and are forwarded unchanged. An unavailable pinned operator requires fresh preparation/signing; the router never automatically resubmits or switches a signed transaction.

All JSON-RPC method names and batches are forwarded to one selected provider, with the original JSON body and upstream response text preserved. A batch cannot pin conflicting providers. Kora decides which methods and transaction formats it supports. The router no longer rejects a transaction merely for exceeding 1,232 bytes or being version 1; the inspected live Kora services report 2.2.0-beta.8, whose transaction support has not established version-1 acceptance. Actual Kora and Solana acceptance of version-1 transactions requires separate end-to-end verification. Router passthrough is not evidence of network support.

### Passive submission measurements

Single `signAndSendTransaction` requests with an explicit `respond_after: "sent"` are timed through receipt of the complete upstream response. Successful acknowledgements must have HTTP success, a matching JSON-RPC ID and a signature-shaped result. Errors, timeouts and malformed acknowledgements count as sampled failures, not fast successes. Batches, notifications, omitted modes, `signed`, `confirmed` and sign-only calls are excluded; all still pass through unchanged. Stock Kora defaults the omitted mode to `confirmed`, so the router never assumes it means `sent` ([Kora v2.2.0-beta.8 source](https://github.com/solana-foundation/kora/blob/v2.2.0-beta.8/crates/lib/src/rpc_server/method/sign_and_send_transaction.rs)).

Each provider/Cloudflare-colo pair retains its last 32 observations for up to seven days, sampled no more than once every 10 seconds. This preserves useful diagnostics when traffic is quiet. Top-level mean, median and nearest-rank p95 describe successful retained historical samples; counts and success rate describe that retained sample, **not total requests or an audited SLA**. `ageMs` is time since the last observation and `stale` means no observation in the past hour. The separate `routing` summary includes only individually timestamped observations from the past hour; it is null if none remain. A recent failure or success never refreshes older observations. `/operators` and `x-neiro-routing` expose `submissionStats`. No transaction bodies, signatures, wallet addresses beyond existing operator identity, or credentials are stored in this history. Measurements are self-reported provider acknowledgements, not proof of on-chain landing.

Fastest uses submission median only when **every eligible candidate** has at least five successful observations from the past hour and at least 90% sampled success in that same fresh subset, in the same serving colo and explicit sent mode. Seven-day historical metrics never supply routing confidence or latency. A one-hour window is a practical low-traffic beta default, not evidence that operator performance stays constant for an hour. Missing/stale evidence restores the existing quote/config fallback instead of excluding new providers. Cheapest keeps fee as the primary criterion and may use submission latency only as a tie-breaker. Pins are unchanged; a signed payment is never replayed or moved. These are aggregate observations of mixed real workloads, not controlled transfer-versus-transfer comparisons: more swaps on one provider can make it appear slower. No transaction parsing or new client parameter is introduced to claim workload equivalence.

Persistence runs under `waitUntil`. Cache API suppresses repeated writes and an atomic D1 predicate limits accepted history updates across isolates; concurrent cache misses can still issue no-op SQL statements. The existing 60/120-second snapshot cache bounds propagation delay. Observations older than seven days are filtered on read, compacted on updates and pruned by minute maintenance in batches of up to 500 regional records; a large backlog can delay physical deletion. The 15-minute cleanup preserves regional records containing unexpired submission history; removed operators still have their observations deleted. No extra operator calls, test payments, Durable Objects or router Solana RPC connection are needed.

Routing diagnostics are in the `x-neiro-routing` response header, exposed through CORS. The upstream JSON response body is not wrapped or changed. This remains a Kora endpoint, not a general Solana RPC service.

## Background checks and operating cost

Each active colo targets one configuration check and one equivalent sample quote per operator per minute. Each sample asks Kora for a fresh blockhash first. Identity and hosted-proof checks are additional. The router calls only Kora HTTP endpoints; Kora uses its own Solana RPC.

Bounded oldest-first background batches rotate through all eligible operators. Small pools fit in one batch; larger pools rotate over active requests. Sparse traffic, endpoint timeouts and execution limits can delay coverage. A colo with no traffic does not continuously probe. The minute cron independently refreshes shared eligibility and sample prices under region `SCHEDULED`; its latency is never used as a user's local measurement. Sampling volume therefore scales with active locations, not just operator count.

Routing snapshots refresh in the background after 60 seconds and can be used for at most 120 seconds, subject to their original measurement expiry. Successful checks do not evict snapshots. Recent local transport failures and HTTP 429/5xx responses exclude an operator for 30 seconds before sending the next request; pinned requests fail rather than switch. Requests are never automatically replayed. `/operators` exposes sample cost, sample timing and customer quote diagnostics separately.

## Explicit bounds

These are operating defaults or safety boundaries, not claims of unlimited capacity:

| Setting or boundary | Default / behavior |
|---|---|
| Request rate limit | 50 requests/IP/10 seconds/Cloudflare location; change the Wrangler rate-limit binding. Includes RPC, listing and admission; health and OPTIONS are exempt. |
| `ADMISSION_REQUESTS_PER_IP_HOUR` | 60 combined register/verify/remove attempts/IP/hour; no global admission quota. A normal register+verify uses two attempts. |
| Verification cooldown | 60 seconds/registration. |
| Pending expiry | 15 minutes. |
| Ownership/identity maintenance | Due after ten minutes; `MAINTENANCE_BATCH_SIZE=100` records/invocation, four concurrent. Larger backlogs take multiple runs. |
| `REGIONAL_CONFIG_BATCH_SIZE` | Defaults to `min(pool,max(6,ceil(pool/4)))`; bounded at 10,000/check batch. Optional override 1–10,000. |
| `CONFIG_CHECK_CONCURRENCY` | Six; configurable 1–32. Platform connection limits still apply. |
| Background time budgets | Traffic: 20 seconds total. Scheduled: 240 seconds total. Platform limits may interrupt earlier. |
| Background quote concurrency | Two; targets one sample/operator/minute per active colo and scheduled sweep. |
| Health / regional sample latency freshness | Five minutes. Sample cost freshness eleven minutes. |
| Failure backoff | Configuration failures two minutes; transport/protocol failures 30 seconds. Regional connection failure does not globally disable the operator. |
| Cache | Directory and observations: 60 seconds fresh, background refresh through 120 seconds, then a required D1 read. Original measurement timestamps still govern eligibility. |
| `MAX_RPC_BODY_BYTES` / `MAX_RPC_RESPONSE_BYTES` | 1,048,576 bytes each; configurable. No separate fixed serialized-transaction-size cap. |
| `UPSTREAM_TIMEOUT_MS` | 30,000ms for forwarded customer requests; configurable. No automatic retry. |
| Background timeouts | Config 2 seconds; blockhash 3 seconds; sample quote 4 seconds; proof 5 seconds; admission identity/config 8 seconds each. |
| Admission / proof / inspection body sizes | 2 KiB registration input, 1 KiB proof, 64 KiB internal Kora response. |
| Endpoint format | At most 256 characters, HTTPS hostname, no credentials, explicit port, query or fragment; no redirects or configured router-host loops. |
| Sample number handling | Background quote amounts must be nonnegative JS safe integers; otherwise sample is rejected. Customer response text is preserved. |
| Worker CPU | Template sets 30,000ms CPU limit; this is not a wall-clock latency target. |
| Logging | Template head sampling rate is 0.1 (10%); no request bodies, wallet keys or API secrets are logged by application code. |

Rate limits and ownership proof reduce some abuse; they are not complete DDoS or Sybil prevention. Multiple hostnames/endpoints can belong to one operator. Automatic enrollment checks advertised Kora identity/configuration, not a cryptographic proof of transaction safety. Operators and merchants retain their respective Kora and signing protections.

`CONFIGURED_OPERATORS` optionally supplies deployment-owned public `{url,payer,paymentAddress}` entries. These bypass the hosted proof only after identity inspection. Leave it unset for self-registration only.

The shipped repository contains source, configuration, schema/migration and documentation. Test harnesses, reports, demos, wallets and deployment credentials stay outside it.

## Cloudflare edge routing

Keep default Worker placement near the incoming request; Smart Placement is not enabled. Cloudflare documents regional health measurements with EWMA in [Dynamic Steering](https://developers.cloudflare.com/load-balancing/understand-basics/traffic-steering/steering-policies/dynamic-steering/). This Worker follows that measurement pattern; it does not provision Cloudflare Load Balancing. [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) entries are local to each data center. [waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/) keeps bounded refresh work off the response path. Cold/expired caches still need database reads. Request-rate, size, timeout, routing-pin and loop protections remain as documented above; they do not decide which Kora methods or transaction instructions are allowed.

## Operator connection

Applications call the Cloudflare Worker, which forwards directly to the operator’s public stock Kora HTTPS endpoint. There is no operator-side Rust router, method-filtering wrapper, or required Caddy proxy. Operators choose their own HTTPS hosting and security. A local development Kora can use an ordinary tunnel directly to its listening port; this is not part of the production router package.

## D1 routing reads

Enable D1 read replication in the database settings. Routing directory and observation reads share a request-scoped `DB.withSession("first-unconstrained")` session so cache misses can use read replicas. Enrollment, removal, leases and background writes retain the primary binding. Replicas may lag; existing observation and health timestamps still expire normally. Sessions do not guarantee globally immediate removals or eliminate cold-cache database round trips. See [Cloudflare read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

## Routing-state cleanup

The minute cron deletes regional rows and shared observations whose newest quote/config measurement is older than 15 minutes, plus orphaned observations. Regional rows with retained submission history are the exception: they survive until that history expires after seven days; individual expired submission events are pruned independently even on active rows. Active regional failure backoff is preserved. Coordination records are deleted 15 minutes after their lease deadline. Each table deletes at most 500 rows per maintenance run, so a backlog drains over subsequent runs. Freshness limits for routing remain five minutes for health/latency and eleven minutes for sample costs; retention does not extend eligibility. Registered operators remain until removal or failed ownership verification. Directory maintenance is scheduled only; payment/list requests no longer acquire its D1 lease.
