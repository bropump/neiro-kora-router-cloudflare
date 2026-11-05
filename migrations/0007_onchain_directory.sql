-- Stop using URL enrollment and transaction tracking. Onchain entries are rebuilt by cron.
DELETE FROM operators WHERE json_extract(data,'$.listing') IS NULL;
DELETE FROM regional_stats WHERE operator_id NOT IN (SELECT id FROM operators);
DELETE FROM operator_observations WHERE operator_id NOT IN (SELECT id FROM operators);
DROP TABLE IF EXISTS limits;
DROP TRIGGER IF EXISTS network_activity_insert;
DROP TRIGGER IF EXISTS network_activity_delete;
DROP TRIGGER IF EXISTS network_activity_update;
DROP TABLE IF EXISTS network_transactions;
DROP TABLE IF EXISTS network_activity_counts;
DROP TABLE IF EXISTS network_activity_meta;
