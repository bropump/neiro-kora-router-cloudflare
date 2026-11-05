# Upgrade from URL enrollment

1. Back up the existing D1 database and deployment metadata.
2. Add the `SOLANA_RPC_URL` Worker secret (read-only chain discovery/funding).
3. Deploy this source and apply `migrations/0007_onchain_directory.sql`.
4. Wait for cron and check `/operators`, then an unsigned `/rpc` request.

Old URL registration/configured-operator entries are no longer accepted. Operators
must have a valid NPN v5 listing; there is no manual bypass. The migration drops
legacy enrollment and transaction-activity tables. `/dashboard`, `/network/activity`
and `/operators/register|verify|remove` are retired. Remove obsolete enrollment,
activity and funding settings after a successful deployment.

The upstream NPN operator docs and Kora services are not modified by this upgrade.
