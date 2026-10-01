# NEIRO Kora router for Cloudflare Workers

One public JSON-RPC URL routes to independently operated public HTTPS Kora endpoints. Operators keep their wallets, Solana RPC connections, pricing and security policies. The router stores public metadata and measurements, not operator wallet secrets or API keys. It uses Workers, D1 and Cache API; no Durable Objects, custom Solana programs, merchant SDK wrapper or operator signing ceremony.

## Deploy

1. Use Workers Paid for the background schedule. Install dependencies with `npm install`, then authenticate with `npx wrangler login`.
2. Create the database: `npx wrangler d1 create neiro-kora-router`.
3. Set its database ID in `wrangler.jsonc`. Set the Worker name and every router hostname in comma-separated `ROUTER_HOSTS`.
4. For a new database: `npx wrangler d1 execute neiro-kora-router --remote --file=schema.sql`.
5. For an existing installation with the old unique-hostname schema, back up its database and apply: `npx wrangler d1 execute neiro-kora-router --remote --file=migrations/0002_multiple_endpoints_per_hostname.sql`.
6. Deploy with `npx wrangler deploy`. Check `/healthz` and `/operators` on your Worker URL.

There is no fixed 100-operator admission cap. Different paths on the same hostname can register separately. Removing a cap does not prove unlimited capacity: directory and observation reads currently load complete result sets, so D1 response size, memory, CPU and background execution limits remain relevant at large scale. No claim of 1,000 independently hosted production operators is made.

A new deployment has no eligible providers until one registers successfully. The template enables admission and submission. `ENROLLMENT_OPEN=false` closes registration and verification; proof-authorized removal remains available; `ENABLE_SUBMISSIONS=false` blocks methods whose names start with `sign` or `transfer`. This switch is not an exhaustive classifier for arbitrary future mutating methods.

## Join and leave

Run unmodified Kora behind a public HTTPS URL. Enable `get_config`, `get_payer_signer`, `estimate_transaction_fee` and `sign_and_send_transaction`, and accept NEIRO mint `CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump`. Fund your payer and configure your own reimbursement policy.

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

Fastest compares fresh real quote timings only when every eligible candidate has a recent real quote observation from the serving Cloudflare colo. Otherwise it compares local configuration-response timings consistently across candidates. An operator's 50ms configuration response is not compared numerically with another operator's 500ms transaction quote. Missing local measurements rank behind measured candidates. An entirely cold comparison chooses provisionally with randomized ties; this is explicitly reported as `cold-start`, not proven fastest. Real quote workloads can still differ by transaction complexity.

Cheapest uses fresh sample amounts when all candidates have successful samples with the same template and payment mint. Samples expire after eleven minutes. Otherwise it falls back to advertised comparable prices. An advertised free provider can be selected ahead of paid pricing. Mixed paid fixed-fee/markup groups require an explicit `priceGroup`, such as `margin` or `fixed:<mint>:<strict>`; URL-encode it. `priceGroup` restricts the candidate group before sample comparison.

Samples are unsigned empty transactions, not representative transfer, swap or account-creation quotes. The cheapest sample or advertised markup is **not a guarantee of the lowest final NEIRO payment**. Token conversion, rent, transaction complexity and operator configuration can change the final amount. Kora supplies the actual transaction quote; the merchant must check it before signing. The router does not implement pricing, simulation, sponsorship policy or wallet-balance validation. Eligibility alone does not prove the provider can fund every payment.

`getPayerSigner` selects an operator during preparation. Recognized transaction encodings are inspected only to obtain the payer for routing; the router does not validate or rebuild the transaction. Explicit `provider`, `operator` and `signer_key` pins must agree. The earliest verified binding for a payer remains the default, with deployment-configured endpoints taking priority. A newly registered duplicate cannot displace or disable that binding; use an explicit operator ID to choose an alternative. An offline primary is not silently replaced. This is continuity policy, not cryptographic proof of wallet possession. Payer changes require removal and re-registration. Unknown transaction encodings require an explicit provider/operator pin and are forwarded unchanged. An unavailable pinned operator requires fresh preparation/signing; the router never automatically resubmits or switches a signed transaction.

All JSON-RPC method names and batches are forwarded to one selected provider, with the original JSON body and upstream response text preserved. A batch cannot pin conflicting providers. Kora decides which methods and transaction formats it supports. The router no longer rejects a transaction merely for exceeding 1,232 bytes or being version 1; the inspected live Kora services report 2.2.0-beta.8, whose transaction support has not established version-1 acceptance. Actual Kora and Solana acceptance of version-1 transactions requires separate end-to-end verification. Router passthrough is not evidence of network support.

Routing diagnostics are in the `x-neiro-routing` response header, exposed through CORS. The upstream JSON response body is not wrapped or changed. This remains a Kora endpoint, not a general Solana RPC service.

## Background checks and operating cost

The shared schedule targets one configuration check/operator/minute and one sample quote/operator/ten minutes. Each sample also asks Kora for a blockhash. Identity and hosted-proof checks are additional. Configuration requests do not ask the router to contact Solana; quote and blockhash requests may cause Kora to contact its own RPC, depending on Kora and caches.

Each active colo separately targets complete regional configuration coverage in one minute: four batches about 15 seconds apart, each sized `ceil(operatorCount/4)`, with six concurrent requests by default. Checks run in background, never as an all-provider scan awaited by the payment. Sparse traffic, slow/failing endpoints or execution limits can delay completion. Oldest-first checks resume unfinished work.

For 100 operators, targets are **100 shared configuration calls/minute plus 100 regional configuration calls/minute per active colo**, and ten shared sample quotes/minute plus ten blockhash requests/minute. Ten active colos therefore target 1,100 configuration calls/minute, not 100 globally. Shared and regional schedules can overlap in observations; costs scale with active colos, traffic, D1 activity and operator count. Count router HTTP calls separately from downstream Solana RPC calls.

Cron has a separate sweep lease so active traffic cannot displace offline-provider recovery; per-operator leases still deduplicate checks. Cron runs once per minute and uses measurement region `SCHEDULED`; its latency is never treated as user-colo latency. Configuration successes, real quotes and sample quotes retain their measurement timestamps and location. `/operators` exposes public eligibility, pricing and measurement metadata, including verified but currently unhealthy entries marked ineligible.

## Explicit bounds

These are operating defaults or safety boundaries, not claims of unlimited capacity:

| Setting or boundary | Default / behavior |
|---|---|
| Request rate limit | 50 requests/IP/10 seconds/Cloudflare location; change the Wrangler rate-limit binding. Includes RPC, listing and admission; health and OPTIONS are exempt. |
| `ADMISSION_REQUESTS_PER_IP_HOUR` | 60 combined register/verify/remove attempts/IP/hour; no global admission quota. A normal register+verify uses two attempts. |
| Verification cooldown | 60 seconds/registration. |
| Pending expiry | 15 minutes. |
| Ownership/identity maintenance | Due after ten minutes; `MAINTENANCE_BATCH_SIZE=100` records/invocation, four concurrent. Larger backlogs take multiple runs. |
| `REGIONAL_CONFIG_BATCH_SIZE` | Defaults to `ceil(pool/4)`; bounded at 10,000/check batch. Optional override 1–10,000. |
| `CONFIG_CHECK_CONCURRENCY` | Six; configurable 1–32. Platform connection limits still apply. |
| Background time budgets | Traffic: config 12 seconds, total probe phase 21 seconds. Scheduled: config 120 seconds, probe phase 240 seconds. Platform limits may interrupt earlier. |
| Background quote concurrency | Two; buckets target one sample/operator/ten minutes. |
| Health / real quote freshness | Five minutes. Sample cost freshness eleven minutes. |
| Failure backoff | Configuration failures two minutes; quote transport/protocol failures 30 seconds. Regional connection failure does not globally disable the operator. |
| Cache | Directory 15 seconds, fallback retaining original five-minute health expiry; observations ten seconds, bounded 30-second outage fallback. No freshness timestamp is extended. |
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
