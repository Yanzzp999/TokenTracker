-- Account-level sources serve CORRECTABLE account snapshots, not append-only
-- machine logs: TRAE CN (trae-cn) can revise a session's totals downward,
-- move it to another model, or shift its half-hour bucket. Deduplicating
-- those corrections at the HOUR level cannot work: a fresh device's snapshot
-- starts at its first observed session, so an hour-level owner can never
-- safely displace a stale tuple for an hour the fresh snapshot has no data
-- for (that would require an unproven "absent = deleted" contract), and a
-- bucket migration (10:00 -> 10:30) leaves the old hour stranded.
--
-- Fix: canonical truth at the SESSION level. TRAE's usage API carries a
-- session_id whose observed stability splits into (evidence 2026-08-17,
-- one account, three real fetches 137 -> 141 -> 164 sessions):
--   repeated-fetch stability        VERIFIED (137/137 persisted across two
--                                   independent fetches, 0 disappearances;
--                                   one session revised upward mid-window
--                                   KEPT its session_id)
--   cross-window stability          VERIFIED (window-subset queries return
--                                   exact id subsets)
--   no duplicate ids                OBSERVED (all fetched responses)
--   cross-device same-account       NOT DIRECTLY VERIFIED: the request body
--                                   carries no device discriminator, but that
--                                   is necessary, not sufficient - a device
--                                   or login context could ride inside the
--                                   JWT / server auth context. No second
--                                   independent device/auth experiment was
--                                   run. If it were ever DISPROVEN (same
--                                   logical session, different ids per
--                                   device), this PK would split one logical
--                                   session into competing rows and the
--                                   identity must be re-evaluated.
-- The CLI parser (src/lib/rollout.js) emits one queue record per CHANGED
-- session (kind: "account_session_state"); the ingest edge upserts them
-- here via tokentracker_upsert_account_session_states(). Identity is
-- (user_id, source, session_id) - device_id is NOT part of the identity
-- (the API request carries no device discriminator; see the stability
-- split above for what that does and does not prove).
--
-- Three corrections become ONE whole-row replace:
--   downward   S tokens 100 -> 60        row replaced, total 60
--   model      S model A -> B            row replaced, only B=100 remains
--   bucket     S bucket 10:00 -> 10:30   row replaced, only 10:30=100
-- A fresh device with no cursor history simply uploads the sessions it sees;
-- the upsert's LWW guard reconciles versions across devices.
--
-- Absence is NOT PROVEN to mean deletion (see the parser's empty-payload
-- note): nothing here ever deletes a session row. Corrections are explicit
-- observations only.
--
-- Freshness: the API exposes NO provider-side ordering signal (headers carry
-- only CDN trace ids; rows have no revision/updated_at - probed 2026-08-17).
-- snapshot_verified_at is the CLIENT fetch stamp, set once per real fetch
-- and replayed verbatim by the append-only queue. The upsert applies an
-- observation only when its stamp is STRICTLY NEWER (>) than the stored
-- one, so a transport retry of an old observation is a no-op, and the same
-- observation replayed is idempotent. This is best-effort cross-device
-- ordering, NOT strict correctness: client clock skew can mis-order two
-- conflicting observations of one session, and a sufficiently
-- future-skewed client timestamp can delay later corrections (residual
-- risk; there is no mechanism bounding the skew).
--
-- Semantics mirrored by src/lib/account-usage-dedup.js and pinned by
-- test/account-usage-dedup.test.js. Apply BEFORE re-deploying the updated
-- scripts/ops/account-usage-grouped-rpc.sql and the ingest edge (both read /
-- write this table).
-- Rollback: DROP TABLE tokentracker_account_session_states; DROP FUNCTION
-- tokentracker_upsert_account_session_states(uuid, jsonb); and re-apply the
-- previous leaderboard_hourly_dedup_v2 definition.

CREATE TABLE IF NOT EXISTS public.tokentracker_account_session_states (
  user_id uuid NOT NULL,
  source text NOT NULL,
  -- Provider-side session identity (TRAE session_id): stable across
  -- repeated fetches and window changes (VERIFIED), account-scoped rather
  -- than device-scoped in the request (cross-device id stability itself is
  -- NOT DIRECTLY VERIFIED - see the header's evidence split).
  session_id text NOT NULL,
  model text NOT NULL,
  -- Canonical UTC half-hour bucket of this session's CURRENT placement.
  bucket_start timestamptz NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  cached_input_tokens bigint NOT NULL,
  cache_creation_input_tokens bigint NOT NULL,
  reasoning_output_tokens bigint NOT NULL,
  total_tokens bigint NOT NULL,
  -- Client logical fetch stamp (see the freshness note above). Ops metadata
  -- only - updated_at (first server write time) never participates in
  -- correctness.
  snapshot_verified_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source, session_id),
  CHECK (
    total_tokens =
      input_tokens + cached_input_tokens + cache_creation_input_tokens + output_tokens
  ),
  CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0
    AND cache_creation_input_tokens >= 0 AND reasoning_output_tokens >= 0
    AND total_tokens >= 0
  )
);

ALTER TABLE public.tokentracker_account_session_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_account_session_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_account_session_states TO project_admin;

-- Aggregation reads group by (user, source, bucket).
CREATE INDEX IF NOT EXISTS tokentracker_account_session_states_bucket_idx
  ON public.tokentracker_account_session_states (user_id, source, bucket_start);

-- Batch LWW upsert used by the ingest edge (the SDK's upsert cannot express
-- a conditional DO UPDATE). SECURITY DEFINER with a locked search_path; the
-- edge calls it with the service-role token after authenticating the device.
-- A strict ">" guard makes replay idempotent and prevents a transport retry
-- of an older observation from displacing a newer one; conflicting
-- observations with EQUAL stamps keep the first-applied row (stable under
-- retries).
CREATE OR REPLACE FUNCTION public.tokentracker_upsert_account_session_states(
  p_user_id uuid,
  p_states jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_applied integer;
BEGIN
  INSERT INTO tokentracker_account_session_states AS t
    (user_id, source, session_id, model, bucket_start,
     input_tokens, output_tokens, cached_input_tokens,
     cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
     snapshot_verified_at)
  SELECT
    p_user_id, x.source, x.session_id, x.model, x.bucket_start,
    x.input_tokens, x.output_tokens, x.cached_input_tokens,
    x.cache_creation_input_tokens, x.reasoning_output_tokens, x.total_tokens,
    x.snapshot_verified_at
  FROM jsonb_to_recordset(p_states) AS x(
    source text, session_id text, model text, bucket_start timestamptz,
    input_tokens bigint, output_tokens bigint, cached_input_tokens bigint,
    cache_creation_input_tokens bigint, reasoning_output_tokens bigint,
    total_tokens bigint, snapshot_verified_at timestamptz)
  ON CONFLICT (user_id, source, session_id) DO UPDATE SET
    model = EXCLUDED.model,
    bucket_start = EXCLUDED.bucket_start,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cached_input_tokens = EXCLUDED.cached_input_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    reasoning_output_tokens = EXCLUDED.reasoning_output_tokens,
    total_tokens = EXCLUDED.total_tokens,
    snapshot_verified_at = EXCLUDED.snapshot_verified_at,
    updated_at = now()
  WHERE EXCLUDED.snapshot_verified_at > t.snapshot_verified_at;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN v_applied;
END
$fn$;

REVOKE ALL ON FUNCTION public.tokentracker_upsert_account_session_states(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tokentracker_upsert_account_session_states(uuid, jsonb)
  TO project_admin;

-- Leaderboard: account-level sources now aggregate from SESSION STATES (the
-- canonical cross-device truth), machine-level sources keep the cluster
-- dedup. trae-cn hourly rows (per-device local reconciliations) never enter
-- the leaderboard - the session-state branch replaces both the previous
-- watermark-owner branch and the legacy MAX fallback for trae-cn. 'cursor'
-- (identical rows across devices, no session identity) keeps the legacy
-- whole-row MAX dedup. Historical rollup days self-heal through the cyclic
-- repair in leaderboard_rollup_daily_advance_v2 (superseded below): 7 days
-- per scheduled run (total refresh, every ~6h) from the OLDEST history day,
-- wrapping. FIRST SEEDS are prioritized: when a closed day has trae-cn
-- session states but no trae-cn rollup row yet, the repair window jumps
-- there, so a new account's first ~30-day seed heals in
-- ceil(seed_span / 7) scheduled runs (~30h at the 6h cadence) instead of a
-- full cycle. Corrections to already-covered days (stale values, row exists)
-- keep the ordinary cyclic schedule - their lag scales with TOTAL history
-- length, not the correction's age. Live paths (account_usage_grouped,
-- bounded leaderboard windows) reflect everything immediately. An immediate
-- full rebuild is optional for instant parity (call
-- leaderboard_rollup_daily_replace_v2 for the affected range).
CREATE OR REPLACE FUNCTION public.leaderboard_hourly_dedup_v2(
  p_from timestamptz,
  p_to timestamptz
) RETURNS TABLE (
  user_id uuid,
  source text,
  model text,
  hour_start timestamptz,
  total_tokens bigint,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  cache_creation_input_tokens bigint,
  reasoning_output_tokens bigint
)
LANGUAGE sql STABLE
AS $func$
  WITH cfg AS (
    SELECT ARRAY['cursor', 'trae-cn']::text[] AS account_sources
  )
  -- Deduplicate device-id drift/replays inside one physical machine cluster,
  -- then add genuinely distinct machines for the same user/hour/model.
  SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
    SUM(mac.total_tokens)::bigint                AS total_tokens,
    SUM(mac.input_tokens)::bigint                AS input_tokens,
    SUM(mac.output_tokens)::bigint               AS output_tokens,
    SUM(mac.cached_input_tokens)::bigint         AS cached_input_tokens,
    SUM(mac.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
    SUM(mac.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source,
      h.model,
      h.hour_start
    )
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text) AS machine_cluster_id,
      h.source, h.model, h.hour_start,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h
    CROSS JOIN cfg
    JOIN tokentracker_devices d
      ON d.id = h.device_id AND d.revoked_at IS NULL
    LEFT JOIN tokentracker_device_machine dm
      ON dm.device_id = h.device_id
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND NOT (h.source = ANY(cfg.account_sources))
    ORDER BY
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source,
      h.model,
      h.hour_start,
      h.total_tokens DESC,
      h.updated_at DESC
  ) mac
  GROUP BY mac.user_id, mac.source, mac.model, mac.hour_start

  UNION ALL

  -- 'cursor' (account-level but with NO stable session identity): rows are
  -- identical across devices, so the legacy whole-row MAX pick per
  -- (user, hour, source, model) dedups them.
  SELECT acct.user_id, acct.source, acct.model, acct.hour_start,
    acct.total_tokens, acct.input_tokens, acct.output_tokens,
    acct.cached_input_tokens, acct.cache_creation_input_tokens,
    acct.reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
      h.user_id, h.source, h.model, h.hour_start,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND h.source = 'cursor'
    ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
  ) acct

  UNION ALL

  -- trae-cn: canonical account truth aggregated from session states. Every
  -- device's observations of the same session collapsed to ONE row by the
  -- LWW upsert; corrections (downward / model / bucket) are already
  -- reflected because each session exists exactly once.
  SELECT s.user_id, s.source, s.model, s.bucket_start AS hour_start,
    SUM(s.total_tokens)::bigint                AS total_tokens,
    SUM(s.input_tokens)::bigint                AS input_tokens,
    SUM(s.output_tokens)::bigint               AS output_tokens,
    SUM(s.cached_input_tokens)::bigint         AS cached_input_tokens,
    SUM(s.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
    SUM(s.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
  FROM tokentracker_account_session_states s
  WHERE s.bucket_start >= p_from AND s.bucket_start < p_to
    AND s.source = 'trae-cn'
  GROUP BY s.user_id, s.source, s.model, s.bucket_start
$func$;

-- ---------------------------------------------------------------------------
-- leaderboard_rollup_daily_advance_v2: supersede the 20260804043427 definition
-- with FIRST-SEED PRIORITIZATION for trae-cn. Everything else (7-day catch-up
-- bootstrap, cyclic 7-day repair from the oldest history day) is unchanged.
--
-- Why: a new account's first TRAE sync seeds ~30 CLOSED days of session
-- states in one upload. Live paths (account_usage_grouped, bounded
-- leaderboard windows) read session states directly and see the seed
-- immediately, but the leaderboard TOTAL reads the MATERIALIZED rollup for
-- closed days - which has never covered them. The plain cyclic repair would
-- reach the seed only after up to a FULL cycle (history_days / 7 scheduled
-- runs), leaving the TOTAL undercounted versus account/profile for days.
-- The fix is a repositioning only: when the earliest closed day that HAS
-- trae-cn session states but NO trae-cn rollup row exists, the repair window
-- JUMPS there. The seed range then rebuilds deterministically at 7 days per
-- scheduled run (ceil(seed_span / 7) runs; a 30-day seed = 5 runs ~= 30h at
-- the ~6h total-refresh cadence). Corrections to already-covered days are
-- NOT gaps (their rollup row exists, merely stale) and keep the ordinary
-- cyclic schedule; per-run work stays bounded by the same 7-day chunk, so
-- the memory/statement-time budget that motivated the cyclic design is
-- unchanged. Mirrored by the createRollupSim harness and pinned by scenario
-- D in test/leaderboard-rollup-correction.test.js.
CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_advance_v2()
RETURNS void
LANGUAGE plpgsql
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_from timestamptz;
  v_target timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_until timestamptz;
  v_min_day date;
  v_repair_from date;
  v_seed_gap_day date;
BEGIN
  SELECT
    (date_trunc('day', MIN(h.hour_start) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date
  INTO v_min_day
  FROM public.tokentracker_hourly h;
  v_min_day := COALESCE(v_min_day, (v_target AT TIME ZONE 'UTC')::date);

  SELECT m.through, m.repair_from INTO v_from, v_repair_from
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1
  FOR UPDATE;

  IF v_from IS NULL THEN
    v_from := v_min_day::timestamp AT TIME ZONE 'UTC';
    v_repair_from := v_min_day;
    INSERT INTO public.tokentracker_leaderboard_rollup_meta_v2 (
      id, through, repair_from, rebuilt_at
    ) VALUES (1, v_from, v_repair_from, now());
  END IF;

  IF v_from < v_target THEN
    -- Bootstrap/catch-up: advance at most seven closed days per request.
    v_until := LEAST(v_target, v_from + interval '7 days');
    PERFORM public.leaderboard_rollup_daily_replace_v2(v_from, v_until);
    UPDATE public.tokentracker_leaderboard_rollup_meta_v2
    SET through = v_until,
        rebuilt_at = now()
    WHERE id = 1;
    RETURN;
  END IF;

  -- Once caught up, continuously repair seven historical days per scheduled
  -- total refresh. Late history uploads, device revocations, and cluster-map
  -- changes therefore self-heal without another whole-history memory spike.
  IF v_repair_from >= (v_target AT TIME ZONE 'UTC')::date THEN
    v_repair_from := v_min_day;
  END IF;

  -- First-seed / uncovered-day prioritization (trae-cn): jump the repair
  -- window to the earliest CLOSED day that has trae-cn session states but
  -- no trae-cn rollup row yet (see the function header comment). Coverage
  -- is PER USER (the rollup PK starts at user_id): another user's same-day
  -- row does NOT cover this user's seed. A day whose rollup row exists for
  -- that user (even with stale values) is NOT a gap - corrections keep the
  -- ordinary cyclic schedule.
  SELECT MIN((s.bucket_start AT TIME ZONE 'UTC')::date) INTO v_seed_gap_day
  FROM public.tokentracker_account_session_states s
  WHERE s.source = 'trae-cn'
    AND (s.bucket_start AT TIME ZONE 'UTC')::date < (v_target AT TIME ZONE 'UTC')::date
    AND NOT EXISTS (
      SELECT 1 FROM public.tokentracker_leaderboard_rollup_daily_v2 r
      WHERE r.user_id = s.user_id
        AND r.source = 'trae-cn'
        AND r.day = (s.bucket_start AT TIME ZONE 'UTC')::date
    );
  IF v_seed_gap_day IS NOT NULL THEN
    v_repair_from := v_seed_gap_day;
  END IF;

  v_until := LEAST(
    v_target,
    (v_repair_from::timestamp AT TIME ZONE 'UTC') + interval '7 days'
  );
  PERFORM public.leaderboard_rollup_daily_replace_v2(
    v_repair_from::timestamp AT TIME ZONE 'UTC',
    v_until
  );
  UPDATE public.tokentracker_leaderboard_rollup_meta_v2
  SET repair_from = CASE
        WHEN v_until >= v_target THEN v_min_day
        ELSE (v_until AT TIME ZONE 'UTC')::date
      END,
      rebuilt_at = now()
  WHERE id = 1;
END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_rollup_daily_advance_v2()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_rollup_daily_advance_v2()
  TO project_admin;
