# NEIRO Kora router for Cloudflare Workers

One public JSON-RPC URL selects from independently operated, public HTTPS Kora services. Operators retain their own Kora configuration, payer wallets, Solana RPC connections and infrastructure. The router stores public endpoint metadata and measurements, not operator wallet secrets or API keys. It uses Workers, D1 and Cache API; no Durable Objects.

## Deploy your own router

These instructions assume this Cloudflare package is the repository root. If working in the older Rust checkout, first enter its `edge` directory.

1. Use the **Workers Paid** plan for the 100-operator schedule; Free-plan invocation and D1 limits are insufficient. Install Node.js, run `npm install`, then authenticate with `npx wrangler login`.
2. Create storage: `npx wrangler d1 create neiro-kora-router`.
3. Put its returned database ID in `wrangler.jsonc`. Set the Worker name and `ROUTER_HOSTS` to your exact public hostname. Include every custom hostname, comma-separated, to reject obvious routing loops.
4. Apply storage: `npx wrangler d1 execute neiro-kora-router --remote --file=schema.sql`.
5. Deploy: `npx wrangler deploy`.
6. Check `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/healthz` and `/operators`.

The template enables public registration and `signAndSendTransaction`. Set `ENROLLMENT_OPEN` or `ENABLE_SUBMISSIONS` to `"false"` when you want either disabled. No Solana RPC key is needed by the Worker: quotes and submission use each selected operator's Kora service. Do not attach private network/VPC bindings to this public endpoint router.

The current admission limit is **100 operators**, one per hostname. This is a bounded beta deployment, not proof of 1,000-node production capacity. Empty deployments return provider unavailable until an operator joins and passes inspection.

## Join as a Kora operator

Run unmodified Kora behind a public HTTPS endpoint. Configure it to accept NEIRO (`CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump`) and enable `get_config`, `get_payer_signer`, `estimate_transaction_fee` and `sign_and_send_transaction`. The operator funds its payer and manages its own reimbursement pricing and security policy.

Submit the public URL:

```sh
curl -sS https://YOUR-ROUTER/operators/register \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://YOUR-OPERATOR/rpc"}'
```

The response contains an `id`, `verificationUrl` and a small `verification` JSON object. Serve that object at the exact `verificationUrl` on your operator's hostname, then verify:

```sh
curl -sS https://YOUR-ROUTER/operators/verify \
  -H 'Content-Type: application/json' \
  --data '{"id":"REGISTRATION_ID_FROM_RESPONSE"}'
```

Keep that file available. No wallet signature, wallet upload, API key exchange or daily renewal is required. The public challenge proves hostname control; it does not prove unmodified Kora software. Initial pending registration expires after 15 minutes. To leave, change the proof's `enabled` value to `false`; maintenance disables routing to the record. An unavailable or ineligible operator is excluded and periodically rechecked for recovery. This is eventual withdrawal, not instantaneous cancellation of an in-flight request.

Operators may use their own reverse proxy, CDN, rate limits and DDoS protection. Their public Kora endpoint remains independently callable; this design does not enforce exclusive traffic through this router.

## Use with Kora

Set the ordinary Kora client's endpoint to:

- `/rpc` or `/rpc?selection=fastest`: fastest fresh quote response measurement from the serving Cloudflare region, with regional configuration timing as fallback.
- `/rpc?selection=cheapest`: lowest **advertised comparable pricing**, with measured latency breaking ties.

Mixed fixed-fee and markup pricing cannot be accurately ranked against one another. Specify `priceGroup=margin`, `priceGroup=free` or `priceGroup=fixed:<mint>:<strict>` when the pool contains incomparable pricing groups (URL-encode the value). The selected operator supplies the actual transaction-specific quote. Merchants must inspect the amount before signing; the router does not implement sponsorship policy, simulate payments or calculate operator pricing.

`getPayerSigner` chooses the operator during preparation. For transaction calls, the router reads the serialized fee payer and pins that operator. Explicit `provider`, `operator` or `signer_key` selections must agree with the transaction. Ambiguous shared-payer records fail rather than silently selecting another operator. No retries or operator switching occur after submission. A failed pinned operator requires a fresh preparation/signing flow.

Supported methods: `getConfig`, `getPayerSigner`, `getSupportedTokens`, `getBlockhash`, `estimateTransactionFee`, `signAndSendTransaction`. This is not a general Solana RPC endpoint. Responses preserve Kora's result and add public `routing` diagnostics; the router never rewrites signed transaction bytes.

## Background measurements

Each operator is scheduled for one shared configuration inspection per minute and one unsigned sample quote per ten minutes. Checks are staggered into ten minute buckets, with at most four configuration calls and two quote probes in parallel. Shared D1 leases prevent every active location from repeating the full schedule. Cron keeps the schedule moving when customer traffic is quiet; a traffic-triggered background refresh can also perform due work. These are scheduling targets subject to failures and execution limits.

Configuration and unsigned sample measurements run in background. A customer request reads cached operator measurements and forwards to one selected operator without waiting for an all-operator refresh. Actual customer quote responses also update quote-latency history. Samples use an unsigned empty transaction and identify their timestamp, token, measurement region and template. They are diagnostic estimates rather than a representative transfer/account-creation price; a failed sample must not be shown as a fresh successful quote. Sample results describe the supplied sample, not a guaranteed fee for every possible payment.

Configuration checks do not initiate Solana RPC calls. Sample quote/blockhash calls can cause work on the operator's own Solana RPC. The number of underlying calls depends on Kora and its caches; it must not be reported as equal to the router's HTTP request count. In addition to the shared configuration schedule, each active Cloudflare region explores at most five operators per minute, capped at 100 additional configuration checks per minute globally. This gathers local timing without every region scanning every operator; complete regional coverage is not guaranteed. For 100 stable operators, the shared baseline is 100 configuration checks and 10 sample quotes per minute, plus at most 100 regional configuration checks. Identity and hostname-proof maintenance are additional. Limits deduplicate global sampling across Worker isolates rather than multiplying a full operator scan at every Cloudflare location. Regional timings describe their measurement location, never inferred user geography.

`GET /operators` exposes only public eligibility/pricing/timing fields, not raw registration records. Expired health measurements are excluded. Selection is sampled and cached, so neither absolute global fastest nor globally cheapest final transaction is guaranteed.

## Admission and operating limits

Admission has per-IP and global hourly budgets, a hostname limit, bounded responses, HTTPS-only endpoint validation and redirect rejection. Traffic has Cloudflare per-location request limiting. Those limits reduce abuse; they are not a complete DDoS or Sybil defense. Cloudflare and operator protections still matter. Background outages may delay onboarding or leave measurements stale; there is no promise that every Cloudflare location will have recent measurements immediately.

`CONFIGURED_OPERATORS` is optional deployment-owned JSON of public `{url,payer,paymentAddress}` entries. These bypass the public hostname proof only when their inspected identity matches the deployment configuration. Leave unset for public self-registration only.

The repository contains deployable router source only. Test harnesses, local demos, operator configuration, wallet files and deployment credentials are not distributed with it.
