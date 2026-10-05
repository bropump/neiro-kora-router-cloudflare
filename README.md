# NEIRO Kora Router

One Cloudflare URL for independent Kora operators. Routes requests by regional response time or estimated fee, with transaction contents unchanged.

**Live endpoint:** `https://api.mainnet-beta.neiropay.app/rpc`

[Live network dashboard](https://api.mainnet-beta.neiropay.app/dashboard) — operator fees and recent response times from Cloudflare locations with traffic.

## Use it

Set your Kora client's endpoint to:

- `/rpc?selection=fastest` — default; uses recent regional measurements.
- `/rpc?selection=cheapest` — lowest comparable sample fee.

Prepare the payment with the selected payer and keep that provider pinned through signing. The router never retries or moves a signed payment to another provider. Kora supplies the actual transaction quote; check the fee before signing. Sample prices and response times do not guarantee the cheapest final payment or fastest landing.

`GET /operators` lists currently eligible operators; use `?includeInactive=true` to inspect unavailable and archived entries. It shows availability, prices, timings and operator-reported `hostingRegions`. Its `measurementColo` identifies the Cloudflare location used for regional measurements, not the Kora hosting location. Clients do not need this field to transact. `GET /healthz` checks the Worker. Responses include routing details in `x-neiro-routing`.

## Run an operator

Follow the [operator setup guide](https://github.com/bropump/neiro-payment-network-core/blob/main/docs/JOIN.md). Operators run stock Kora, keep their own wallets and RPC credentials, and choose their fees.

**New deployments default to closed enrollment.** The router administrator must approve configured operators or explicitly enable HTTPS-only enrollment. Endpoint control does not prove possession of the payer key. When enrollment is open, join by submitting your public HTTPS URL to `/operators/register`, hosting the returned verification JSON, and calling `/operators/verify`. No wallet signature or operator API key is given to the router. [Registration commands](https://github.com/bropump/neiro-payment-network-core/blob/main/docs/REGISTRATION.md).

## Deploy your own router

Requires Node.js 24, Cloudflare Workers Paid, D1 and a trusted mainnet Solana RPC for readiness checks. The public RPC is the default; a production deployment should configure a reliable `FUNDING_RPC_URL`. No Durable Objects or operator signing keys are used.

```sh
npm ci
npx wrangler login
npx wrangler d1 create neiro-kora-router
```

Set the database ID, Worker name and `ROUTER_HOSTS` in `wrangler.jsonc`, then:

```sh
npx wrangler d1 execute neiro-kora-router --remote --file=schema.sql
npm run deploy
```

For a custom domain, add a `routes` entry such as `{ "pattern": "api.mainnet-beta.neiropay.app", "custom_domain": true }` to the deployment config. Set `ROUTER_HOSTS` to all router hostnames, comma-separated, with the primary hostname first. The NEIRO deployment uses `api.mainnet-beta.neiropay.app,neiro-cf-router-demo.optical.workers.dev`; keep both so loop prevention also covers the previous address. Use your own domain for an independent router.

A new deployment needs an approved configured operator or explicitly enabled enrollment before it can route payments. Keep a minute cron enabled. Operators must expose both Kora signing methods, keep the SOL payer funded, and create/fund the NEIRO fee-recipient ATA themselves. Zero NEIRO in that ATA is permitted. Operator endpoints stay public; operators manage their own security and availability.

[Routing, caching and limits](docs/OPERATIONS.md) · [Database upgrades](docs/UPGRADING.md)

### Operator hosting locations

The dashboard shows operator hosting locations separately from Cloudflare measurement locations. An empty `hostingRegions` list means unknown; the router never fills it with the caller’s location, a Cloudflare edge location, or an IP-geolocation guess. To publish yours, add an optional `hostingRegions` list to your existing verification JSON, keeping its token and enabled flag:

```json
{
  "token": "YOUR_EXISTING_TOKEN",
  "enabled": true,
  "hostingRegions": ["Frankfurt, Germany", "Singapore", "New York, USA"]
}
```

Use your actual hosting locations. These are operator-reported labels, not independently verified locations, and do not influence routing. One endpoint can list several regions. Call `/operators/verify` after updating the file; periodic ownership checks also pick up changes. Omit the field or use an empty list to clear it. Up to 16 labels of 80 characters each are supported. Deployment-configured operators use the same optional field in their `CONFIGURED_OPERATORS` entry. Kora configuration remains unchanged.

### Regression tests

Run `npm test`, `npm run typecheck` and `npm run format:check`. The local tests cover readiness, lifecycle, payer pins, raw forwarding/no replay, bounded probes, activity accounting, and location display using public fixtures and in-memory SQLite. They make no external requests or payments. The 100/1,000-entry fixtures demonstrate bounded scheduling, not production capacity at that scale.
