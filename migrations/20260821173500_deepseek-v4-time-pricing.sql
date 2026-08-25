-- Preserve DeepSeek V4's official UTC peak/off-peak price tier through the
-- account and leaderboard aggregation layers. The existing aggregate RPCs
-- collapse hours before edge pricing, so the tier must be part of the group.

CREATE INDEX IF NOT EXISTS tokentracker_hourly_deepseek_v4_hour_idx
  ON public.tokentracker_hourly (hour_start, user_id, device_id, source, model)
  WHERE lower(model) LIKE '%deepseek-v4-flash%'
     OR lower(model) LIKE '%deepseek-v4-pro%';

CREATE INDEX IF NOT EXISTS tokentracker_session_states_deepseek_v4_hour_idx
  ON public.tokentracker_account_session_states (bucket_start, user_id, source, model)
  WHERE lower(model) LIKE '%deepseek-v4-flash%'
     OR lower(model) LIKE '%deepseek-v4-pro%';

ALTER FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) RENAME TO account_usage_grouped_legacy_v1;

CREATE OR REPLACE FUNCTION public.account_usage_deepseek_v4_grouped(
  p_user_id uuid,
  p_device_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  WITH tzr AS (
    SELECT CASE
      WHEN p_tz IS NOT NULL AND p_tz <> ''
       AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
      THEN p_tz ELSE NULL
    END AS tz
  ), hourly AS (
    SELECT mac.hour_start, mac.source, mac.model,
      mac.total_tokens, mac.input_tokens, mac.output_tokens,
      mac.cached_input_tokens, mac.cache_creation_input_tokens,
      mac.reasoning_output_tokens, mac.conversations
    FROM (
      SELECT DISTINCT ON (
        COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.hour_start, h.source, h.model
      )
        h.hour_start, h.source, h.model,
        h.total_tokens::bigint AS total_tokens,
        h.input_tokens::bigint AS input_tokens,
        h.output_tokens::bigint AS output_tokens,
        h.cached_input_tokens::bigint AS cached_input_tokens,
        h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
        h.reasoning_output_tokens::bigint AS reasoning_output_tokens,
        h.conversations::bigint AS conversations
      FROM public.tokentracker_hourly h
      LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = h.device_id
      WHERE h.user_id = p_user_id
        AND h.hour_start >= p_from AND h.hour_start < p_to
        AND h.source NOT IN ('cursor', 'trae-cn')
        AND h.device_id = ANY(p_device_ids)
        AND (lower(h.model) LIKE '%deepseek-v4-flash%'
          OR lower(h.model) LIKE '%deepseek-v4-pro%')
      ORDER BY COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) mac

    UNION ALL

    SELECT d.hour_start, d.source, d.model,
      d.total_tokens, d.input_tokens, d.output_tokens,
      d.cached_input_tokens, d.cache_creation_input_tokens,
      d.reasoning_output_tokens, d.conversations
    FROM (
      SELECT DISTINCT ON (h.hour_start, h.source, h.model)
        h.hour_start, h.source, h.model,
        h.total_tokens::bigint AS total_tokens,
        h.input_tokens::bigint AS input_tokens,
        h.output_tokens::bigint AS output_tokens,
        h.cached_input_tokens::bigint AS cached_input_tokens,
        h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
        h.reasoning_output_tokens::bigint AS reasoning_output_tokens,
        h.conversations::bigint AS conversations
      FROM public.tokentracker_hourly h
      WHERE h.user_id = p_user_id
        AND h.hour_start >= p_from AND h.hour_start < p_to
        AND h.source = 'cursor'
        AND (lower(h.model) LIKE '%deepseek-v4-flash%'
          OR lower(h.model) LIKE '%deepseek-v4-pro%')
      ORDER BY h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) d

    UNION ALL

    SELECT s.bucket_start, s.source, s.model,
      SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint,
      SUM(s.output_tokens)::bigint, SUM(s.cached_input_tokens)::bigint,
      SUM(s.cache_creation_input_tokens)::bigint,
      SUM(s.reasoning_output_tokens)::bigint, COUNT(*)::bigint
    FROM public.tokentracker_account_session_states s
    WHERE s.user_id = p_user_id
      AND s.bucket_start >= p_from AND s.bucket_start < p_to
      AND s.source = 'trae-cn'
      AND (lower(s.model) LIKE '%deepseek-v4-flash%'
        OR lower(s.model) LIKE '%deepseek-v4-pro%')
    GROUP BY s.bucket_start, s.source, s.model
  ), located AS (
    SELECT
      CASE p_trunc
        WHEN 'hour' THEN to_char(date_trunc('hour', local_ts), 'YYYY-MM-DD"T"HH24:00:00')
        WHEN 'day' THEN to_char(date_trunc('day', local_ts), 'YYYY-MM-DD')
        WHEN 'month' THEN to_char(date_trunc('month', local_ts), 'YYYY-MM')
        ELSE ''
      END AS bucket,
      source, model,
      CASE WHEN (extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 1
                      AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 4)
                  OR (extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 6
                      AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 10)
        THEN 'peak' ELSE 'off_peak' END AS pricing_tier,
      total_tokens, input_tokens, output_tokens, cached_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, conversations
    FROM hourly CROSS JOIN tzr
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN tzr.tz IS NOT NULL THEN hour_start AT TIME ZONE tzr.tz
        WHEN p_offset_min IS NOT NULL
          THEN (hour_start AT TIME ZONE 'UTC') + make_interval(mins => p_offset_min)
        ELSE hour_start AT TIME ZONE 'UTC'
      END AS local_ts
    ) local_time
  ), grouped AS (
    SELECT bucket, source, model, pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens,
      SUM(conversations)::bigint AS conversations
    FROM located
    GROUP BY bucket, source, model, pricing_tier
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(grouped.*) ORDER BY bucket, source, model, pricing_tier),
    '[]'::jsonb
  ) FROM grouped
$func$;

CREATE OR REPLACE FUNCTION public.account_usage_grouped(
  p_user_id uuid,
  p_device_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  WITH legacy_rows AS (
    SELECT value || jsonb_build_object('pricing_tier', 'peak') AS value
    FROM jsonb_array_elements(public.account_usage_grouped_legacy_v1(
      p_user_id, p_device_ids, p_from, p_to, p_trunc, p_tz, p_offset_min
    ))
    WHERE lower(value->>'model') NOT LIKE '%deepseek-v4-flash%'
      AND lower(value->>'model') NOT LIKE '%deepseek-v4-pro%'
  ), deepseek_rows AS (
    SELECT value
    FROM jsonb_array_elements(public.account_usage_deepseek_v4_grouped(
      p_user_id, p_device_ids, p_from, p_to, p_trunc, p_tz, p_offset_min
    ))
  )
  SELECT COALESCE(
    jsonb_agg(value ORDER BY value->>'bucket', value->>'source', value->>'model', value->>'pricing_tier'),
    '[]'::jsonb
  )
  FROM (SELECT value FROM legacy_rows UNION ALL SELECT value FROM deepseek_rows) rows
$func$;

-- SQL-language calls are bound to function OIDs. Recreate v2 after renaming
-- the legacy function so it resolves the new account_usage_grouped wrapper.
CREATE OR REPLACE FUNCTION public.account_usage_grouped_v2(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  WITH active AS (
    SELECT COALESCE(array_agg(d.id ORDER BY d.id), ARRAY[]::uuid[]) AS ids
    FROM public.tokentracker_devices d
    WHERE d.user_id = p_user_id AND d.revoked_at IS NULL
  ), scoped AS (
    SELECT ids,
      CASE WHEN p_device_id IS NOT NULL AND p_device_id = ANY(ids)
        THEN ARRAY[p_device_id]::uuid[] ELSE ids END AS selected_ids
    FROM active
  )
  SELECT CASE WHEN cardinality(ids) = 0 THEN '[]'::jsonb
    ELSE public.account_usage_grouped(
      p_user_id, selected_ids, p_from, p_to, p_trunc, p_tz, p_offset_min
    ) END
  FROM scoped
$func$;

-- Version the shared cache key so no pre-migration JSON lacking pricing_tier
-- can be served after deployment, even if a concurrent old request refills it.
CREATE OR REPLACE FUNCTION public.account_usage_grouped_cached(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
DECLARE
  v_cache_key text;
  v_result jsonb;
BEGIN
  v_cache_key := concat_ws(
    chr(31), 'v2-deepseek-time-pricing', p_user_id::text,
    COALESCE(p_device_id::text, ''),
    to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_trunc, COALESCE(p_tz, ''), COALESCE(p_offset_min::text, '')
  );

  SELECT c.result INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN RETURN v_result; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_cache_key, 0));
  SELECT c.result INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN RETURN v_result; END IF;

  v_result := public.account_usage_grouped_v2(
    p_user_id, p_device_id, p_from, p_to, p_trunc, p_tz, p_offset_min
  );

  INSERT INTO public.tokentracker_account_usage_cache AS c (cache_key, fetched_at, result)
  VALUES (v_cache_key, clock_timestamp(), v_result)
  ON CONFLICT (cache_key) DO UPDATE
  SET fetched_at = EXCLUDED.fetched_at, result = EXCLUDED.result;

  IF random() < 0.01 THEN
    WITH stale AS (
      SELECT s.cache_key
      FROM public.tokentracker_account_usage_cache s
      WHERE s.fetched_at < clock_timestamp() - interval '5 minutes'
      ORDER BY s.fetched_at, s.cache_key
      FOR UPDATE SKIP LOCKED
      LIMIT 256
    )
    DELETE FROM public.tokentracker_account_usage_cache c
    USING stale WHERE c.cache_key = stale.cache_key;
  END IF;
  RETURN v_result;
END
$func$;

REVOKE ALL ON FUNCTION public.account_usage_grouped_legacy_v1(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_usage_deepseek_v4_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) TO project_admin;
REVOKE ALL ON FUNCTION public.account_usage_grouped_v2(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped_v2(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) TO project_admin;
REVOKE ALL ON FUNCTION public.account_usage_grouped_cached(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped_cached(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_deepseek_v4_grouped(
  p_from timestamptz, p_to timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '25s'
AS $func$
  WITH hourly AS (
    SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
      SUM(mac.total_tokens)::bigint AS total_tokens,
      SUM(mac.input_tokens)::bigint AS input_tokens,
      SUM(mac.output_tokens)::bigint AS output_tokens,
      SUM(mac.cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(mac.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(mac.reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM (
      SELECT DISTINCT ON (h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text), h.source, h.model, h.hour_start)
        h.user_id, h.source, h.model, h.hour_start,
        h.total_tokens, h.input_tokens, h.output_tokens, h.cached_input_tokens,
        h.cache_creation_input_tokens, h.reasoning_output_tokens
      FROM public.tokentracker_hourly h
      JOIN public.tokentracker_devices d ON d.id = h.device_id AND d.revoked_at IS NULL
      LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = h.device_id
      WHERE h.hour_start >= p_from AND h.hour_start < p_to
        AND h.source NOT IN ('cursor', 'trae-cn')
        AND (lower(h.model) LIKE '%deepseek-v4-flash%' OR lower(h.model) LIKE '%deepseek-v4-pro%')
      ORDER BY h.user_id, COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
    ) mac
    GROUP BY mac.user_id, mac.source, mac.model, mac.hour_start

    UNION ALL

    SELECT acct.user_id, acct.source, acct.model, acct.hour_start,
      acct.total_tokens, acct.input_tokens, acct.output_tokens,
      acct.cached_input_tokens, acct.cache_creation_input_tokens, acct.reasoning_output_tokens
    FROM (
      SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
        h.user_id, h.source, h.model, h.hour_start, h.total_tokens,
        h.input_tokens, h.output_tokens, h.cached_input_tokens,
        h.cache_creation_input_tokens, h.reasoning_output_tokens
      FROM public.tokentracker_hourly h
      WHERE h.hour_start >= p_from AND h.hour_start < p_to
        AND h.source = 'cursor'
        AND (lower(h.model) LIKE '%deepseek-v4-flash%' OR lower(h.model) LIKE '%deepseek-v4-pro%')
      ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
    ) acct

    UNION ALL

    SELECT s.user_id, s.source, s.model, s.bucket_start,
      SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint, SUM(s.output_tokens)::bigint,
      SUM(s.cached_input_tokens)::bigint, SUM(s.cache_creation_input_tokens)::bigint,
      SUM(s.reasoning_output_tokens)::bigint
    FROM public.tokentracker_account_session_states s
    WHERE s.bucket_start >= p_from AND s.bucket_start < p_to
      AND s.source = 'trae-cn'
      AND (lower(s.model) LIKE '%deepseek-v4-flash%' OR lower(s.model) LIKE '%deepseek-v4-pro%')
    GROUP BY s.user_id, s.source, s.model, s.bucket_start
  ), grouped AS (
    SELECT user_id, source, model,
      CASE WHEN (extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 1
                      AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 4)
                  OR (extract(hour FROM hour_start AT TIME ZONE 'UTC') >= 6
                      AND extract(hour FROM hour_start AT TIME ZONE 'UTC') < 10)
        THEN 'peak' ELSE 'off_peak' END AS pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens, SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM hourly
    GROUP BY user_id, source, model, pricing_tier
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(grouped.*) ORDER BY user_id, source, model, pricing_tier),
    '[]'::jsonb
  ) FROM grouped
$func$;

CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped(
  p_from timestamptz, p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO public, pg_temp
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_through timestamptz;
  v_cut timestamptz;
  v_base jsonb;
  v_deepseek jsonb;
BEGIN
  SELECT m.through INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m WHERE m.id = 1;
  v_cut := date_trunc('day', LEAST(v_through, p_to) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  IF v_through IS NOT NULL
     AND p_from = date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     AND v_cut > p_from THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(per_usm.*) ORDER BY user_id, source, model), '[]'::jsonb)
    INTO v_base
    FROM (
      SELECT u.user_id, u.source, u.model, 'peak'::text AS pricing_tier,
        SUM(u.total_tokens)::bigint AS total_tokens, SUM(u.input_tokens)::bigint AS input_tokens,
        SUM(u.output_tokens)::bigint AS output_tokens,
        SUM(u.cached_input_tokens)::bigint AS cached_input_tokens,
        SUM(u.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
        SUM(u.reasoning_output_tokens)::bigint AS reasoning_output_tokens
      FROM (
        SELECT r.user_id, r.source, r.model, r.total_tokens, r.input_tokens, r.output_tokens,
          r.cached_input_tokens, r.cache_creation_input_tokens, r.reasoning_output_tokens
        FROM public.tokentracker_leaderboard_rollup_daily_v2 r
        WHERE r.day >= (p_from AT TIME ZONE 'UTC')::date
          AND r.day < (v_cut AT TIME ZONE 'UTC')::date
          AND lower(r.model) NOT LIKE '%deepseek-v4-flash%'
          AND lower(r.model) NOT LIKE '%deepseek-v4-pro%'
        UNION ALL
        SELECT t.user_id, t.source, t.model, t.total_tokens, t.input_tokens, t.output_tokens,
          t.cached_input_tokens, t.cache_creation_input_tokens, t.reasoning_output_tokens
        FROM public.leaderboard_hourly_dedup_v2(v_cut, p_to) t
        WHERE lower(t.model) NOT LIKE '%deepseek-v4-flash%'
          AND lower(t.model) NOT LIKE '%deepseek-v4-pro%'
      ) u GROUP BY u.user_id, u.source, u.model
    ) per_usm;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(per_usm.*) ORDER BY user_id, source, model), '[]'::jsonb)
    INTO v_base
    FROM (
      SELECT d.user_id, d.source, d.model, 'peak'::text AS pricing_tier,
        SUM(d.total_tokens)::bigint AS total_tokens, SUM(d.input_tokens)::bigint AS input_tokens,
        SUM(d.output_tokens)::bigint AS output_tokens,
        SUM(d.cached_input_tokens)::bigint AS cached_input_tokens,
        SUM(d.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
        SUM(d.reasoning_output_tokens)::bigint AS reasoning_output_tokens
      FROM public.leaderboard_hourly_dedup_v2(p_from, p_to) d
      WHERE lower(d.model) NOT LIKE '%deepseek-v4-flash%'
        AND lower(d.model) NOT LIKE '%deepseek-v4-pro%'
      GROUP BY d.user_id, d.source, d.model
    ) per_usm;
  END IF;

  v_deepseek := public.leaderboard_deepseek_v4_grouped(p_from, p_to);
  RETURN COALESCE(v_base, '[]'::jsonb) || COALESCE(v_deepseek, '[]'::jsonb);
END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_deepseek_v4_grouped(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leaderboard_usage_grouped(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_usage_grouped(timestamptz, timestamptz)
  TO project_admin;

-- Cached JSON created before this migration does not contain pricing_tier.
DELETE FROM public.tokentracker_account_usage_cache;
