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

-- Public transaction signatures only. No request bodies or client identities.
CREATE TABLE IF NOT EXISTS network_activity_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO network_activity_meta VALUES (1, unixepoch()*1000);
CREATE TABLE IF NOT EXISTS network_transactions (
 signature TEXT PRIMARY KEY,
 operator_id TEXT NOT NULL,
 submitted_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','confirmed','finalized','failed','unknown')),
 checked_at INTEGER,
 next_check_at INTEGER NOT NULL,
 slot INTEGER
);
CREATE INDEX IF NOT EXISTS network_transactions_recent ON network_transactions(submitted_at DESC);
CREATE INDEX IF NOT EXISTS network_transactions_status ON network_transactions(status,next_check_at);
