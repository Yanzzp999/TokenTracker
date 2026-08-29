-- The detector runs hourly. Re-reading fourteen event days plus fourteen days
-- of recently touched history made one scan visit hundreds of thousands of
-- raw rows; under concurrent backend work PostgreSQL terminated that session
-- before it could advance the durable scan heartbeat.
--
-- One configured day still covers both the current and previous UTC calendar
-- day, while the updated_at branch catches late historical writes made during
-- the last 24 hours. A detector outage remains fail-closed because the GitHub
-- responder rejects a stale heartbeat instead of pretending the scan ran.
-- Function-level runtime caps require the postgres-owned detector's owner and
-- are tracked separately in docs/ops/leaderboard-anomaly-detector-runtime.sql.
DO $migration$
BEGIN
  UPDATE public.tokentracker_anticheat_config
  SET value = 1
  WHERE key = 'lookback_days';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing anti-cheat lookback_days configuration';
  END IF;
END;
$migration$;
