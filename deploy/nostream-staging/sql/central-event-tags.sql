-- Central event_tags maintenance for the relay read path.
--
-- WHY THIS EXISTS
-- ---------------
-- pg-gateway writes every mesh INSERT to the orchestrator's central Postgres
-- first ("execute_capture"), then replicates the captured row to providers.
-- That means the central database already holds the authoritative `events`
-- row, which is what deploy/nostream-staging points the relay's read replica
-- at (instead of the gateway). Reading the same-host copy removes the per-REQ
-- mesh fan-out and is the change that lets us raise the per-IP connection cap.
--
-- `event_tags` is derived from `events.event_tags` by a trigger. Providers
-- maintain it normally, but the gateway captures writes with
-- `session_replication_role = replica`, which deliberately skips normal
-- triggers. The central copy therefore needs the trigger marked ALWAYS, and
-- needs a one-time rebuild for rows written before that.
--
-- RUN THIS AGAINST THE CENTRAL POSTGRES (nso_postgres / orchestrator),
-- NOT against the pg-gateway. Run it with the relay stopped: the rebuild takes
-- a write lock on `events`.
--
-- Safe to re-run (it recreates the trigger and rebuilds the derived table).

BEGIN;

-- Same function body as nostream migration
-- 20240108_130100_add_event_tags_table.js. Keep these in sync.
CREATE OR REPLACE FUNCTION process_event_tags() RETURNS TRIGGER AS $$
DECLARE
  tag_element jsonb;
  tag_name text;
  tag_value text;
BEGIN
  -- deleted_at/quarantined_at updates leave the tags alone; skip the rewrite.
  IF TG_OP = 'UPDATE'
     AND OLD.event_id IS NOT DISTINCT FROM NEW.event_id
     AND OLD.event_tags IS NOT DISTINCT FROM NEW.event_tags THEN
    RETURN NEW;
  END IF;

  DELETE FROM event_tags WHERE event_id = OLD.event_id;

  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    FOR tag_element IN SELECT jsonb_array_elements(NEW.event_tags)
    LOOP
      tag_name := trim((tag_element->0)::text, '"');
      tag_value := trim((tag_element->1)::text, '"');
      IF length(tag_name) = 1 AND tag_value IS NOT NULL AND tag_value <> '' THEN
        INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (NEW.event_id, tag_name, tag_value);
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `session_replication_role = replica` (used by execute_capture) fires only
-- triggers marked REPLICA or ALWAYS, never normal triggers.
DROP TRIGGER IF EXISTS insert_event_tags ON events;
CREATE TRIGGER insert_event_tags
AFTER INSERT OR UPDATE OR DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION process_event_tags();

ALTER TABLE events ENABLE ALWAYS TRIGGER insert_event_tags;

-- Rebuild the derived table from the authoritative JSONB column. The lock
-- blocks relay writes for the duration; stop nostream first.
LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE;

TRUNCATE TABLE event_tags;

INSERT INTO event_tags (event_id, tag_name, tag_value)
SELECT
  e.event_id,
  tag ->> 0 AS tag_name,
  tag ->> 1 AS tag_value
FROM events e
CROSS JOIN LATERAL jsonb_array_elements(e.event_tags) AS tag
WHERE jsonb_typeof(e.event_tags) = 'array'
  AND length(tag ->> 0) = 1
  AND tag ->> 1 IS NOT NULL
  AND tag ->> 1 <> '';

COMMIT;
