# Existing database upgrades

Back up the database first. Apply only migrations missing from your installation:

- `0002_multiple_endpoints_per_hostname.sql`: removes the old unique-hostname constraint.
- `0003_regional_samples.sql`: adds regional sample measurements.
- `0004_submission_timings.sql`: adds submission timing history.

```sh
npx wrangler d1 execute neiro-kora-router --remote --file=migrations/MIGRATION.sql
npm run deploy
```

Fresh databases created with `schema.sql` already include these changes. Do not apply them again.

The TypeScript upgrade uses the existing schema. Run `npm ci` to install its pinned development dependencies before deploying.

For the network activity dashboard, apply `migrations/0005_network_activity.sql` before deploying the updated Worker. The migration is additive and idempotent. Keep its tables when rolling back Worker code; dropping them loses recorded totals and signatures.

## Readiness, lifecycle and bounded activity

Apply `migrations/0006_bounded_activity.sql` after `0005` and before deploying the new Worker. It backfills retained status counts and installs insert/update/delete triggers. Fresh `schema.sql` includes both. Counter backfill scans existing telemetry once; plan this separately if the historical table is large. Test the migration against a backup first.

Update old deployment overrides: `MAINTENANCE_BATCH_SIZE` must be at most 25 (default 10), `CONFIG_CHECK_CONCURRENCY` at most 2, and `REGIONAL_CONFIG_BATCH_SIZE` at most 12. Preserve actual D1 IDs, routes and approved configured operators; do not deploy the example Wrangler file over production. New templates close enrollment. Review existing open-enrollment deployments explicitly; changing a template does not change live policy.

Configure a trusted mainnet `FUNDING_RPC_URL` and keep the minute cron enabled. Existing rows have no funding evidence and are temporarily ineligible until the first successful refresh; prime/validate evidence before enabling traffic on an upgrade. A healthy Kora must support both signing methods and have a funded SOL payer plus initialized, rent-exempt NEIRO recipient ATA. Inspect `/operators?includeInactive=true` for failures and `/operators` for eligible entries. Verify a read-only pinned Kora call before declaring rollout healthy.

Legacy disabled entries are hidden from the default directory without deleting payer bindings. Their 24-hour archive clock starts with a newly recorded failure; do not infer historical continuous outage from the old `checkedAt` or `verifiedAt`. Archived entries require explicit successful verification to return. Ownership-based `enabled:false` removal still deletes its row, as requested by its endpoint owner.

Keep the additive counter table and triggers on code rollback. Old code remains schema compatible, but rolling back also removes readiness gates, default-list filtering and activity insertion limits. This release is a small-pool beta: review fresh coverage and RPC/confirmation backlogs before expanding enrollment.
