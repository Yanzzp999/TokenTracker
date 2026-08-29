-- Anti-cheat response used to rebuild week/month/total snapshots through the
-- Edge HTTP path. A total rebuild can outlive the 30-second gateway response:
-- the database work then finishes, the caller retries, and overlapping forced
-- rebuilds amplify load without ever acknowledging the moderation queue.
--
-- The safety-critical response is much smaller: users currently excluded or
-- banned must not remain in any materialized leaderboard snapshot. Perform
-- that deletion and queue acknowledgement in one database transaction. The
-- queue row lock serializes this operation with the trigger that advances the
-- queue version, so a concurrent detector change can never be acknowledged by
-- an older response.
CREATE OR REPLACE FUNCTION public.reconcile_anticheat_snapshot_exclusions(
  p_queue_changed_at timestamptz
)
RETURNS TABLE(
  applied boolean,
  deleted_rows bigint,
  response_completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $func$
DECLARE
  v_queue_changed_at timestamptz;
  v_deleted_rows bigint := 0;
BEGIN
  SELECT s.last_queue_changed_at
  INTO v_queue_changed_at
  FROM public.tokentracker_anticheat_run_state s
  WHERE s.id = true
  FOR UPDATE;

  IF NOT FOUND OR v_queue_changed_at IS DISTINCT FROM p_queue_changed_at THEN
    RETURN QUERY SELECT false, 0::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  DELETE FROM public.tokentracker_leaderboard_snapshots s
  WHERE EXISTS (
    SELECT 1
    FROM public.tokentracker_leaderboard_anomaly_flags f
    WHERE f.user_id = s.user_id
      AND f.status IN ('auto_excluded', 'banned')
  );
  GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;

  UPDATE public.tokentracker_anticheat_run_state
  SET last_response_completed_at = p_queue_changed_at
  WHERE id = true;

  RETURN QUERY
  SELECT true, v_deleted_rows, p_queue_changed_at;
END;
$func$;

REVOKE ALL ON FUNCTION public.reconcile_anticheat_snapshot_exclusions(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_anticheat_snapshot_exclusions(timestamptz)
  TO project_admin;
