# NEIRO Kora router

One Cloudflare Workers URL for the same signed onchain operators used by
[NEIRO Payment Network](https://github.com/bropump/neiro-payment-network).
Operators publish normally through NPN; there is no separate router registration.

```text
POST https://YOUR-WORKER/rpc                       # fastest (default)
POST https://YOUR-WORKER/rpc?selection=cheapest    # lowest comparable sample fee
POST https://YOUR-WORKER/rpc?provider=PAYER       # pin an operator
GET  https://YOUR-WORKER/operators
GET  https://YOUR-WORKER/select?selection=fastest&maxMarkupBps=500&method=signTransaction
```

`/select` returns pinned `rpcUrl` and `quoteUrl` values. Optionally include
`maxFeeNeiroRaw` (integer base units; 1000000 = 1 NEIRO) to cap the actual quote
through `quoteUrl`. Use `rpcUrl` for signing and submission. Single quote responses
receive identity/amount checks and are returned unchanged or rejected. Clients
still verify the final transaction; this is not a binding price or signing policy.

Send ordinary Kora JSON-RPC. Requests and responses are forwarded unchanged;
the router never signs, changes transaction bytes or retries a submitted request.
Pin the selected payer when preparing and submitting a payment. `x-neiro-routing`
identifies the chosen operator, measurement region and selection basis.

Fastest uses recent regional response measurements; cheapest uses equivalent
unsigned sample quotes, with comparable advertised pricing as a fallback.
Neither guarantees fastest confirmation or the lowest fee for every payment.
Kora and the client retain responsibility for signing policy and payment approval.

## Deploy

Use Node 24+, `npm ci`, then `npx wrangler login`. Create a D1 database, set its
ID and your hostname in `wrangler.jsonc`, and apply `schema.sql` with Wrangler.
Store a Solana RPC URL supporting finalized `getProgramAccounts`, `getBlock`
and account reads using `npx wrangler secret put SOLANA_RPC_URL`.
Run `npm test`, `npm run typecheck`, then `npm run deploy`.

The minute cron discovers listings every five minutes and refreshes health and
quotes. Allow the first cron to populate the directory. No operator keys, wallet
keys, Durable Objects, extra Kora proxy or Kora changes are needed.

See [operations and limits](docs/OPERATIONS.md) and [upgrading](docs/UPGRADING.md).
