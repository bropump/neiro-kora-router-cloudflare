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
