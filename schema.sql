CREATE TABLE IF NOT EXISTS operators (
 id TEXT PRIMARY KEY, host TEXT NOT NULL, status TEXT NOT NULL,
 created_at INTEGER NOT NULL, checked_at INTEGER NOT NULL, last_attempt INTEGER NOT NULL,
 data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS limits (id TEXT PRIMARY KEY,n INTEGER NOT NULL,reset INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS operators_status ON operators(status,checked_at);

-- CF-colo observations and bounded refresh admission; no Durable Objects.
CREATE TABLE IF NOT EXISTS regional_stats (
 region TEXT NOT NULL, operator_id TEXT NOT NULL,
 quote_json TEXT, config_json TEXT, sample_json TEXT, submission_json TEXT, failed_until INTEGER NOT NULL DEFAULT 0, last_probe_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (region,operator_id)
);
CREATE TABLE IF NOT EXISTS regional_leases (
 id TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL
);

-- Public shared observations; no credentials or customer transactions.
CREATE TABLE IF NOT EXISTS operator_observations (
 operator_id TEXT PRIMARY KEY, config_json TEXT, sample_json TEXT
);
