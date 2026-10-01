-- Existing databases only; fresh schema.sql already includes this column.
ALTER TABLE regional_stats ADD COLUMN submission_json TEXT;
