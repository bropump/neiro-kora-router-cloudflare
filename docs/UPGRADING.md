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
