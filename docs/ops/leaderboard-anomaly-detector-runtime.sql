-- Apply through the database-owner connection: InsForge migrations execute as
-- project_admin, while the database-native detector is intentionally owned by
-- postgres. These caps make a growing candidate set fail closed without
-- destabilizing the database server or losing the previous durable heartbeat.
ALTER FUNCTION public.detect_leaderboard_anomalies()
  SET work_mem TO '16MB';
ALTER FUNCTION public.detect_leaderboard_anomalies()
  SET statement_timeout TO '45s';

COMMENT ON FUNCTION public.detect_leaderboard_anomalies() IS
  'Hourly fail-closed leaderboard anomaly detector; bounded to current/previous UTC day plus 24h late-write coverage.';
