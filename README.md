# NEIRO Kora router for Cloudflare Workers

One public JSON-RPC URL routes to independently operated public HTTPS Kora endpoints. Operators keep their wallets, Solana RPC connections, pricing and security policies. The router stores public metadata and measurements, not operator wallet secrets or API keys. It uses Workers, D1 and Cache API; no Durable Objects, custom Solana programs, merchant SDK wrapper or operator signing ceremony.

## Deploy

1. Use Workers Paid for the background schedule. Install dependencies with `npm install`, then authenticate with `npx wrangler login`.
2. Create the database: `npx wrangler d1 create neiro-kora-router`.
3. Set its database ID in `wrangler.jsonc`. Set the Worker name and every router hostname in comma-separated `ROUTER_HOSTS`.
4. For a new database: `npx wrangler d1 execute neiro-kora-router --remote --file=schema.sql`.
5. For an existing installation with the old unique-hostname schema, back up its database and apply: `npx wrangler d1 execute neiro-kora-router --remote --file=migrations/0002_multiple_endpoints_per_hostname.sql`.
6. For existing installations without regional sample storage, apply `migrations/0003_regional_samples.sql` once. New databases already include it in `schema.sql`.
7. Deploy with `npx wrangler deploy`. Check `/healthz` and `/operators` on your Worker URL.

There is no fixed 100-operator admission cap. Different paths on the same hostname can register separately. Removing a cap does not prove unlimited capacity: directory and observation reads currently load complete result sets, so D1 response size, memory, CPU and background execution limits remain relevant at large scale. No claim of 1,000 independently hosted production operators is made.

A new deployment has no eligible providers until one registers successfully. The template enables admission. `ENROLLMENT_OPEN=false` closes registration and verification; proof-authorized removal remains available. There is no router-level RPC method allowlist, denylist or submission switch; Kora controls method availability.

## Join and leave

Run unmodified Kora behind a public HTTPS URL. Enable `get_config`, `get_payer_signer` and `estimate_transaction_fee`, and accept NEIRO mint `CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump`. Fund your payer and configure your own reimbursement policy. Signing methods are operator-controlled: admission does not require `signAndSendTransaction` or `signTransaction`. Sign-only operators can join. The router forwards the requested method unchanged; an unsupported method returns the operator’s error.

```sh
curl https://YOUR-ROUTER/operators/register \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://YOUR-OPERATOR/rpc"}'
```

Serve the returned `verification` JSON at the returned `verificationUrl`, then:

```sh
curl https://YOUR-ROUTER/operators/verify \
  -H 'Content-Type: application/json' \
  --data '{"id":"REGISTRATION_ID"}'
```

Keep that proof file available. It proves control of the HTTPS hostname, not unmodified Kora code or wallet possession. It is public, not a secret credential. No wallet key, API key, signed code or daily renewal is required. A pending registration expires after 15 minutes.

To leave, change the hosted proof to `enabled:false`. Maintenance will remove the registration. To request removal immediately:

```sh
curl https://YOUR-ROUTER/operators/remove \
  -H 'Content-Type: application/json' \
  --data '{"id":"REGISTRATION_ID"}'
```

The router fetches the owner-controlled proof before removal; knowing the public ID or token alone is insufficient. Cached directory entries and in-flight requests mean withdrawal is eventual. Deployment-configured operators must also be removed from `CONFIGURED_OPERATORS`.

Operators manage their own CDN, rate limits and DDoS protection. Their endpoints remain directly callable. No tunnels or exclusive-access claims are part of this design. Do not attach private-network/VPC bindings to the public router.

## Routing and compatibility

Use `/rpc?selection=fastest` (the default) or `/rpc?selection=cheapest` as the ordinary Kora client endpoint.

Fastest (also the default Auto behavior) compares fresh EWMA timings of the same background fee-estimate sample from the serving Cloudflare colo. Measured candidates rank ahead of unknown candidates; one missing observation cannot downgrade everyone. When no sample timing is available, local configuration-response timing is a labelled fallback. Entirely cold selection is provisional with randomized ties. Customer transaction timings remain diagnostics: unlike workloads are not mixed into the sample ranking.

Cheapest compares fresh sample amounts for the same template and payment mint among measured candidates, using regional sample latency to break ties. Unmeasured providers remain in the background rotation. When no usable sample amounts exist, it falls back to advertised comparable prices. Mixed sample templates/mints cannot be compared. Mixed paid fixed-fee/markup groups require an explicit `priceGroup`, such as `margin` or `fixed:<mint>:<strict>`; URL-encode it. `priceGroup` restricts the candidate group before sample comparison.

Samples are unsigned empty transactions, not representative transfer, swap or account-creation quotes. The cheapest sample or advertised markup is **not a guarantee of the lowest final NEIRO payment**. Token conversion, rent, transaction complexity and operator configuration can change the final amount. Kora supplies the actual transaction quote; the merchant must check it before signing. The router does not implement pricing, simulation, sponsorship policy or wallet-balance validation. Eligibility alone does not prove the provider can fund every payment.

`getPayerSigner` selects an operator during preparation. Recognized transaction encodings are inspected only to obtain the payer for routing; the router does not validate or rebuild the transaction. Explicit `provider`, `operator` and `signer_key` pins must agree. The earliest verified binding for a payer remains the default, with deployment-configured endpoints taking priority. A newly registered duplicate cannot displace or disable that binding; use an explicit operator ID to choose an alternative. An offline primary is not silently replaced. This is continuity policy, not cryptographic proof of wallet possession. Payer changes require removal and re-registration. Unknown transaction encodings require an explicit provider/operator pin and are forwarded unchanged. An unavailable pinned operator requires fresh preparation/signing; the router never automatically resubmits or switches a signed transaction.

All JSON-RPC method names and batches are forwarded to one selected provider, with the original JSON body and upstream response text preserved. A batch cannot pin conflicting providers. Kora decides which methods and transaction formats it supports. The router no longer rejects a transaction merely for exceeding 1,232 bytes or being version 1; the inspected live Kora services report 2.2.0-beta.8, whose transaction support has not established version-1 acceptance. Actual Kora and Solana acceptance of version-1 transactions requires separate end-to-end verification. Router passthrough is not evidence of network support.

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

The minute cron deletes regional measurements and shared observations whose newest measurement is older than 15 minutes, plus orphaned observations. Active regional failure backoff is preserved. Coordination records are deleted 15 minutes after their lease deadline. Each table deletes at most 500 rows per maintenance run, so a backlog drains over subsequent runs. Freshness limits for routing remain five minutes for health/latency and eleven minutes for sample costs; retention does not extend eligibility. Registered operators remain until removal or failed ownership verification. Directory maintenance is scheduled only; payment/list requests no longer acquire its D1 lease.
