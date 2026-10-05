# CF router review fixes

## Findings and result

The old lifecycle disabled unavailable entries but never retired them or hid them from the default directory. The observed stale entry is the former Mac `trycloudflare.com` endpoint; its hostname no longer resolves. Live directory inspection still shows it as ineligible under the old deployed code. No production data or deployment was modified in this change.

Implemented:

- Recent confirmed mainnet payer/ATA checks, scope binding and monotonic evidence. Require a funded plain SOL payer, existing initialized/unfrozen/rent-exempt canonical NEIRO fee ATA, and both Kora signing methods. Zero NEIRO token balance is allowed; sampled fees can raise the SOL floor.
- Independent 20-minute ownership/identity expiry. New templates close enrollment; HTTPS-only enrollment still does not prove payer-key possession.
- Eligible-only default directory, explicit inactive view, outage timestamps, backoff and 24-hour archiving. Archive preserves payer binding, stops automatic probes, and permits explicit full reverification. Old failure timestamps are not misrepresented as last success.
- Preserve newer funding evidence during concurrent verification; prevent stale config events from incorrectly marking newer evidence unavailable.
- Bounded twelve-attempt regional sweeps, concurrency two, persisted oldest-first fairness, bounded activity reconciliation, retained counters and 100,000-record telemetry cap.
- Dashboard pages of 50 with indexed measurements, inactive toggle, diagnostic reasons and retained-window activity labels.
- Maintained regression tests in CI and updated upgrade/operations documentation.

## Verification

26 local tests pass. Type checking, formatting, whitespace checks and Wrangler dry-run build pass. Two independent reviewers approved with notes for the small operator pool. Independent SQLite checks verified legacy activity migration, counters, status changes, deletion and reapplication. Tests cover 100/1,000-entry scheduling bounds; these are not live load tests or proof that all those entries stay fresh.

Read-only live checks confirmed Bunny's pinned payer response and required signing methods. The new mainnet readiness checker found its payer had 9,997,681 lamports and a valid existing NEIRO ATA at slot 453531338. This is a point-in-time observation, not a payment guarantee. No real transfers or signing operations were performed.

## Limits and rollout

Verdict: **APPROVE WITH NOTES — bounded beta**. Wallet-key authorization remains unimplemented. Consumer clients still trust their chosen router. Larger pools need separate fresh-coverage and throughput work; whole-directory reads and per-colo metadata remain capacity considerations. Activity tracking is bounded best-effort telemetry, not audited lifetime volume.

Apply additive migration 0006 after 0005, preserve production bindings/routes, update old batch/concurrency overrides and prime readiness before a live rollout. The template is not a production deployment configuration. See docs/UPGRADING.md. Rolling back code also rolls back readiness enforcement. No live rollout is included in this implementation verification.
