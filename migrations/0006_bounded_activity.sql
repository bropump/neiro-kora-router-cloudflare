-- Retained-window counters. Safe to apply before deploying the new Worker.
CREATE TABLE IF NOT EXISTS network_activity_counts (
 status TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0)
);
INSERT OR REPLACE INTO network_activity_counts(status,count)
 SELECT status,COUNT(*) FROM network_transactions GROUP BY status;
CREATE TRIGGER IF NOT EXISTS network_activity_insert AFTER INSERT ON network_transactions BEGIN
 INSERT INTO network_activity_counts(status,count) VALUES(NEW.status,1)
 ON CONFLICT(status) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS network_activity_delete AFTER DELETE ON network_transactions BEGIN
 UPDATE network_activity_counts SET count=MAX(0,count-1) WHERE status=OLD.status;
END;
CREATE TRIGGER IF NOT EXISTS network_activity_update AFTER UPDATE OF status ON network_transactions WHEN OLD.status!=NEW.status BEGIN
 UPDATE network_activity_counts SET count=MAX(0,count-1) WHERE status=OLD.status;
 INSERT INTO network_activity_counts(status,count) VALUES(NEW.status,1)
 ON CONFLICT(status) DO UPDATE SET count=count+1;
END;
