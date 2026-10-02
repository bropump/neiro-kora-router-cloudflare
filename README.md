# NEIRO Kora Router

One Cloudflare URL for independent Kora operators. Routes requests by regional response time or estimated fee, with transaction contents unchanged.

**Live endpoint:** `https://api.mainnet-beta.neiropay.app/rpc`

## Use it

Set your Kora client's endpoint to:

- `/rpc?selection=fastest` — default; uses recent regional measurements.
- `/rpc?selection=cheapest` — lowest comparable sample fee.

Prepare the payment with the selected payer and keep that provider pinned through signing. The router never retries or moves a signed payment to another provider. Kora supplies the actual transaction quote; check the fee before signing. Sample prices and response times do not guarantee the cheapest final payment or fastest landing.

`GET /operators` shows availability, prices and timings. `GET /healthz` checks the Worker. Responses include routing details in `x-neiro-routing`.

## Run an operator

Follow the [operator setup guide](https://github.com/bropump/neiro-payment-network-core/blob/main/docs/JOIN.md). Operators run stock Kora, keep their own wallets and RPC credentials, and choose their fees.

Join by submitting your public HTTPS URL to `/operators/register`, hosting the returned verification JSON, and calling `/operators/verify`. No wallet signature or operator API key is given to the router. [Registration commands](https://github.com/bropump/neiro-payment-network-core/blob/main/docs/REGISTRATION.md).

## Deploy your own router

Requires Node.js 24, Cloudflare Workers Paid and D1. No Durable Objects or Solana RPC key.

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

A new deployment needs an operator to register before it can route payments. Operator endpoints stay public; operators manage their own security and availability.

[Routing, caching and limits](docs/OPERATIONS.md) · [Database upgrades](docs/UPGRADING.md)
