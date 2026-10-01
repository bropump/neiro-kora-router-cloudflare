-- Apply once to existing databases created with host TEXT UNIQUE.
-- Preserves every operator and removes only the hostname uniqueness constraint.
CREATE TABLE operators_endpoint_identity (
 id TEXT PRIMARY KEY, host TEXT NOT NULL, status TEXT NOT NULL,
 created_at INTEGER NOT NULL, checked_at INTEGER NOT NULL, last_attempt INTEGER NOT NULL,
 data TEXT NOT NULL
);
INSERT INTO operators_endpoint_identity SELECT id,host,status,created_at,checked_at,last_attempt,data FROM operators;
DROP TABLE operators;
ALTER TABLE operators_endpoint_identity RENAME TO operators;
CREATE INDEX operators_status ON operators(status,checked_at);
