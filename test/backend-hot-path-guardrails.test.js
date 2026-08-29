"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const readMigrationBySuffix = (suffix) => {
  const file = fs.readdirSync(path.join(ROOT, "migrations"))
    .find((name) => name.endsWith(`_${suffix}.sql`));
  assert.ok(file, `missing migration ending in _${suffix}.sql`);
  return read(`migrations/${file}`);
};

const ACCOUNT_FUNCTIONS = [
  "tokentracker-account-summary.ts",
  "tokentracker-account-daily.ts",
  "tokentracker-account-hourly.ts",
  "tokentracker-account-monthly.ts",
  "tokentracker-account-heatmap.ts",
  "tokentracker-account-model-breakdown.ts",
];

const USER_JWT_FUNCTIONS = [
  ...ACCOUNT_FUNCTIONS,
  "tokentracker-account-devices.ts",
  "tokentracker-device-flow-grant.ts",
  "tokentracker-device-rename.ts",
  "tokentracker-device-token-issue.ts",
  "tokentracker-leaderboard-profile.ts",
  "tokentracker-leaderboard-refresh.ts",
  "tokentracker-profile-likes.ts",
  "tokentracker-public-visibility.ts",
];

test("user-authenticated edge functions verify current RS256 and legacy HS256 tokens", () => {
  for (const file of USER_JWT_FUNCTIONS) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(source, /header\.alg === "RS256"/u, `${file} must accept current RS256 access tokens`);
    assert.match(source, /Deno\.env\.get\("JWT_PUBLIC_KEY"\)/u, `${file} must verify RS256 with the managed public key`);
    assert.match(source, /RSASSA-PKCS1-v1_5/u, `${file} must use the RS256 Web Crypto algorithm`);
    assert.match(source, /header\.alg === "HS256"/u, `${file} must preserve legacy sessions during migration`);
    assert.match(source, /Deno\.env\.get\("JWT_SECRET"\)/u, `${file} must verify legacy HS256 signatures`);
  }
});

test("cloud account reads use the shared cached RPC instead of a device lookup plus aggregation", () => {
  for (const file of ACCOUNT_FUNCTIONS) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(source, /rpc\("account_usage_grouped_cached"/u,
      `${file} must use the cross-isolate cached RPC`);
    assert.doesNotMatch(
      source,
      /\.from\("tokentracker_devices"\)/u,
      `${file} must not spend a second PostgREST connection resolving devices`,
    );
    assert.match(source, /const groupedRowsInFlight = new Map/u,
      `${file} must coalesce identical concurrent RPC reads`);
    assert.match(source, /GROUPED_ROWS_TTL_MS = 30_000/u,
      `${file} must shield the backend from old-client polling storms`);
    assert.match(source, /GROUPED_ROWS_STALE_IF_ERROR_MS = 5 \* 60_000/u,
      `${file} must retain a bounded stale fallback for transient 5xx responses`);
  }
});

test("shared account cache is bounded, locked per key, and access controlled", () => {
  const source = read("migrations/20260718071507_add-shared-account-usage-cache.sql");
  assert.match(source, /CREATE UNLOGGED TABLE public\.tokentracker_account_usage_cache/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_cached/u);
  assert.match(source, /interval '30 seconds'/u);
  assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(v_cache_key, 0\)\)/u);
  assert.match(source, /public\.account_usage_grouped_v2\(/u);
  assert.match(source, /LIMIT 256/u);
  assert.match(source, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(source, /REVOKE ALL ON public\.tokentracker_account_usage_cache FROM PUBLIC, anon, authenticated/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_grouped_cached/u);
});

test("shared account cache cleanup cannot deadlock concurrent cold fills", () => {
  const source = readMigrationBySuffix("harden-backend-concurrency");
  assert.match(
    source,
    /ORDER BY stale\.fetched_at, stale\.cache_key[\s\S]{0,80}FOR UPDATE SKIP LOCKED[\s\S]{0,80}LIMIT 256/u,
    "cleanup must lock stale rows in one deterministic, non-blocking order",
  );
  assert.match(
    source,
    /DELETE FROM public\.tokentracker_account_usage_cache AS c[\s\S]{0,160}USING stale/u,
    "cleanup must delete only the rows claimed by the skip-locked batch",
  );
});

test("DeepSeek V4 time pricing survives account and leaderboard aggregation", () => {
  const source = readMigrationBySuffix("deepseek-v4-time-pricing");
  assert.match(source, /tokentracker_hourly_deepseek_v4_hour_idx/u);
  assert.match(source, /RENAME TO account_usage_grouped_legacy_v1/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /v2-deepseek-time-pricing/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.leaderboard_deepseek_v4_grouped/u);
  assert.match(source, /THEN 'peak' ELSE 'off_peak'/u);
  assert.match(source, /lower\(r\.model\) NOT LIKE '%deepseek-v4-flash%'/u);
  assert.match(source, /public\.leaderboard_deepseek_v4_grouped\(p_from, p_to\)/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_deepseek_v4_grouped/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.leaderboard_deepseek_v4_grouped/u);
});

test("leaderboard refresh fetches all user metadata with one RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  assert.match(source, /rpc\("leaderboard_user_metadata"/u);
  assert.doesNotMatch(source, /const settingsResults = await Promise\.all/u);
  assert.doesNotMatch(source, /const profilesResults = await Promise\.all/u);
  assert.doesNotMatch(source, /const fallbackResults = await Promise\.all/u);
});

test("total leaderboard advances the cluster-aware rollup before reading it", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const advance = source.indexOf('rpc(\n        "leaderboard_rollup_daily_advance_v2"');
  const aggregate = source.indexOf('rpc(\n      "leaderboard_usage_grouped"');

  assert.ok(advance > 0, "total refresh must advance the v2 closed-day rollup");
  assert.ok(aggregate > advance, "aggregation must read only after the rollup advance succeeds");
  assert.match(source.slice(advance, aggregate), /if \(advanceErr\)[\s\S]*stage: "rollup_advance"/u);
});

test("signed-in users cannot trigger expensive month, total, or all-period leaderboard refreshes", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const clientSource = read("dashboard/src/lib/cloud-sync.ts");
  assert.match(
    source,
    /type RefreshAuthorization = "privileged" \| "signed-in" \| "public";/u,
  );
  assert.match(
    source,
    /if \(authorization === "signed-in" && body\.period !== "week"\)\s*return json\(\{ error: "signed-in users may only refresh week" \}, 403\);/u,
  );
  assert.match(clientSource, /body: JSON\.stringify\(\{ period: "week", source \}\)/u);
});

test("the unauthenticated anomaly summary cannot reach any refresh write path", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");

  // "public" is granted without any credential, so it must be reachable only by
  // a GET carrying ?anomalies=1 -- never by the POST that rebuilds snapshots.
  assert.match(
    source,
    /req\.method === "GET" &&\s*new URL\(req\.url\)\.searchParams\.get\("anomalies"\) === "1"/u,
    "the public role must be gated on GET + ?anomalies=1",
  );
  assert.match(
    source,
    /const authorization = wantsAnomalySummary \? "public" : await authorizeRefresh\(req\);/u,
    "any non-summary request must still go through authorizeRefresh",
  );

  // The summary must return before the period-refresh work begins.
  const summaryReturn = source.indexOf('if (authorization === "public") return await anomalyQueueSummary(client);');
  const periodLoop = source.indexOf("for (const period of periods)");
  assert.ok(summaryReturn > 0, "public role must short-circuit to the summary");
  assert.ok(
    periodLoop > summaryReturn,
    "the public short-circuit must precede the refresh loop",
  );

  // The summary must not leak identities into the public GitHub issue the
  // watchdog files from this payload.
  const summaryBody = source.slice(
    source.indexOf("async function anomalyQueueSummary"),
    source.indexOf("export default async function"),
  );
  assert.doesNotMatch(
    summaryBody,
    /user_id/u,
    "anomaly summary must expose counts only, never flagged user ids",
  );
});

test("leaderboard refresh reconciles stale rows after the replacement snapshot is durable", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const upsertStart = source.indexOf("// Upsert in batches of 200");
  const staleDelete = source.indexOf('.lt("generated_at", generatedAt)');
  const completion = source.indexOf("results[period] = { upserted: upsertRows.length }");

  assert.ok(upsertStart > 0, "snapshot upsert must exist");
  assert.ok(
    staleDelete > upsertStart,
    "stale snapshot cleanup must run only after every replacement row is upserted",
  );
  assert.ok(
    completion > staleDelete,
    "the period must not report success before stale snapshot cleanup finishes",
  );
  assert.match(
    source.slice(upsertStart, completion),
    /\.from\("tokentracker_leaderboard_snapshots"\)\s*\.delete\(\)\s*\.eq\("period", period\)\s*\.eq\("from_day", from_day\)\s*\.eq\("to_day", to_day\)\s*\.lt\("generated_at", generatedAt\)/u,
    "refresh must delete rows left behind by excluded or otherwise removed users in the same snapshot window",
  );
});

test("leaderboard anti-cheat workflow verifies database-native scans, reconciles exclusions, and never leaks identities", () => {
  const workflow = read(".github/workflows/leaderboard-anticheat.yml");
  assert.match(
    workflow,
    /cron: "53 \* \* \* \*"/u,
    "a daily poll can miss a flag created after that day's run for nearly 24 hours",
  );
  assert.doesNotMatch(
    workflow,
    /issues:\s*write|gh issue (?:create|edit|close|list)/u,
    "automatic soft exclusion must not depend on or create a public GitHub issue",
  );
  assert.match(workflow, /secrets\.LEADERBOARD_REFRESH_SECRET/u);
  assert.doesNotMatch(
    workflow,
    /"scan_anomalies":true/u,
    "the HTTP workflow must not synchronously rerun a detector that can exceed the backend proxy timeout",
  );
  assert.match(workflow, /last_scan_completed_at/u);
  assert.match(workflow, /scan_age_seconds/u);
  assert.doesNotMatch(workflow, /force_refresh\\":true/u,
    "anti-cheat response must not rebuild every leaderboard snapshot");
  assert.match(workflow, /anti_cheat_reconcile_at/u,
    "the responder must use the atomic exclusion reconciliation path");
  assert.doesNotMatch(workflow, /for period in week month total/u,
    "the responder must not fan one queue change out into three heavy refreshes");
  const postBranch = workflow.slice(workflow.indexOf('if [[ "$method" == "GET" ]]'));
  assert.doesNotMatch(postBranch.slice(postBranch.indexOf("else")), /--retry-all-errors/u,
    "write requests must not overlap after a lost gateway response");
  assert.match(workflow, /\?anomalies=1/u, "the workflow must independently read back queue state");
  assert.doesNotMatch(workflow, /user_id/u, "workflow logs must never expose flagged identities");
  assert.match(
    workflow,
    /GITHUB_STEP_SUMMARY/u,
    "the health check should retain private run-level observability",
  );
});

test("anti-cheat health reports database-native scan freshness before protected snapshot refresh", () => {
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const migration = read("migrations/20260812115221_observe-database-anticheat-scans.sql");
  const authorizationGuard = source.indexOf('authorization !== "privileged"');
  const periodLoop = source.indexOf("for (const period of periods)");

  assert.match(source, /tokentracker_anticheat_run_state/u);
  assert.match(source, /last_scan_completed_at/u);
  assert.match(migration, /AFTER INSERT ON public\.tokentracker_leaderboard_anomaly_flags/u);
  assert.match(migration, /FOR EACH STATEMENT/u,
    "even a clean zero-row detector INSERT must advance the scan heartbeat");
  assert.ok(authorizationGuard > 0 && authorizationGuard < periodLoop,
    "forced refresh flags must be privileged before snapshots are rebuilt");
  assert.match(source, /p_min_interval_s: forceRefresh \? 0 : 30/u,
    "an authenticated response run must not lose to an unrelated refresh throttle");
  assert.match(source, /timeout: 25_000/u,
    "the bounded detector must have enough client timeout headroom to finish under load");
  assert.match(source, /return json\(\{ ok: true, results, \.\.\.\(anomalyScan \? \{ scan: anomalyScan \} : \{\}\) \}\)/u);
});

test("database-native anti-cheat detector has a bounded hourly scan budget", () => {
  const migration = readMigrationBySuffix("bound-anticheat-detector-window");
  const runtime = read("docs/ops/leaderboard-anomaly-detector-runtime.sql");

  assert.match(migration, /SET value = 1\s+WHERE key = 'lookback_days'/u,
    "an hourly detector must not rescan two weeks of raw event and ingestion history");
  assert.match(migration, /missing anti-cheat lookback_days configuration/u,
    "deployment must fail instead of silently leaving the unbounded configuration in place");
  assert.match(runtime, /ALTER FUNCTION public\.detect_leaderboard_anomalies\(\)\s+SET work_mem TO '16MB'/u,
    "one detector query must not retain the old 64MB per-operation memory budget");
  assert.match(runtime, /SET statement_timeout TO '45s'/u,
    "a runaway detector must fail closed before it destabilizes the database server");
});

test("anti-cheat responder atomically reconciles snapshots only when the moderation queue changed", () => {
  const workflow = read(".github/workflows/leaderboard-anticheat.yml");
  const source = read("dashboard/edge-patches/tokentracker-leaderboard-refresh.ts");
  const migration = readMigrationBySuffix("reconcile-anticheat-snapshot-exclusions");

  assert.match(workflow, /last_queue_changed_at/u);
  assert.match(workflow, /last_response_completed_at/u);
  assert.match(workflow, /needs_response/u,
    "unchanged queues must not repeat snapshot reconciliation every hour");
  assert.match(workflow, /anti_cheat_reconcile_at/u);
  assert.match(workflow, /reconcile request failed; checking durable database state/u,
    "a lost HTTP response must fall through to durable state read-back");
  assert.match(source, /reconcile_anticheat_snapshot_exclusions/u);
  assert.match(source, /reconciled_snapshot_rows/u);
  assert.match(migration, /FOR UPDATE/u,
    "queue reconciliation must serialize against detector queue changes");
  assert.match(migration, /f\.status IN \('auto_excluded', 'banned'\)/u);
  assert.match(migration, /SET last_response_completed_at = p_queue_changed_at/u,
    "snapshot deletion and queue acknowledgement must commit atomically");
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.reconcile_anticheat_snapshot_exclusions/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.reconcile_anticheat_snapshot_exclusions/u);
});

test("leaderboard bans block token issuance and usage ingestion", () => {
  const tokenIssue = read("dashboard/edge-patches/tokentracker-device-token-issue.ts");
  const devicePoll = read("dashboard/edge-patches/tokentracker-device-flow-poll.ts");
  const ingest = read("dashboard/edge-patches/tokentracker-ingest.ts");

  for (const [file, source] of [
    ["tokentracker-device-token-issue.ts", tokenIssue],
    ["tokentracker-device-flow-poll.ts", devicePoll],
    ["tokentracker-ingest.ts", ingest],
  ]) {
    assert.match(source, /Deno\.env\.get\("LEADERBOARD_BLOCKED_USER_IDS"\)/u,
      `${file} must read the production account blocklist`);
    assert.match(source, /return json\(\{ error: "Account blocked" \}, 403\)/u,
      `${file} must reject blocked accounts`);
  }

  assert.ok(
    tokenIssue.indexOf("if (await isUsageBlocked(dbClient, userId))")
      < tokenIssue.indexOf("// Device identity resolution"),
    "normal token issuance must reject the account before mutating a device",
  );
  assert.ok(
    devicePoll.indexOf("if (await isUsageBlocked(client, row.user_id))")
      < devicePoll.indexOf("issueDeviceToken(client, row.user_id"),
    "device-flow polling must reject the account before issuing a token",
  );
  assert.ok(
    ingest.indexOf("if (await isUsageBlocked(client, userId))")
      < ingest.indexOf('.from("tokentracker_hourly")'),
    "ingest must reject the account before writing usage",
  );
  for (const [file, source] of [
    ["tokentracker-device-token-issue.ts", tokenIssue],
    ["tokentracker-device-flow-poll.ts", devicePoll],
    ["tokentracker-ingest.ts", ingest],
  ]) {
    assert.match(source, /\.eq\("status", "auto_excluded"\)/u,
      `${file} must reversibly pause machine-excluded accounts`);
  }
});

test("leaderboard reads expose snapshot freshness and disable response caching", () => {
  const edgeSource = read("dashboard/edge-patches/tokentracker-leaderboard.ts");
  const clientSource = read("dashboard/src/lib/api.ts");
  assert.match(edgeSource, /const snapshotGeneratedAt =/u);
  assert.match(edgeSource, /generated_at: snapshotGeneratedAt/u);
  assert.doesNotMatch(edgeSource, /generated_at: new Date\(\)\.toISOString\(\)/u);
  assert.match(edgeSource, /"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"/u);
  assert.match(
    clientSource,
    /fetchInsforgeFunction\("tokentracker-leaderboard", \{\s*cache: "no-store"/u,
  );
});

test("telemetry heartbeat uses one atomic database upsert RPC", () => {
  const source = read("dashboard/edge-patches/tokentracker-telemetry.ts");
  assert.match(source, /rpc\("upsert_tokentracker_telemetry_daily"/u);
  assert.doesNotMatch(source, /const \{ data: existingRows/u);
  assert.doesNotMatch(source, /\.from\(TABLE\)\.insert/u);
});

test("device creation absorbs concurrent unique-key races without database errors", () => {
  for (const file of ["tokentracker-device-token-issue.ts", "tokentracker-device-flow-poll.ts"]) {
    const source = read(`dashboard/edge-patches/${file}`);
    assert.match(
      source,
      /\.upsert\([\s\S]{0,180}machine_id: machineId[\s\S]{0,80}\{ ignoreDuplicates: true \}/u,
      `${file} must use INSERT ON CONFLICT DO NOTHING before selecting the winner`,
    );
    assert.doesNotMatch(source, /\.insert\([\s\S]{0,180}ignoreDuplicates/u);
  }
});

test("desktop auto refresh does not poll cloud account aggregates every 30 seconds", () => {
  const source = read("dashboard/src/pages/DashboardPage.jsx");
  assert.match(source, /if \(!isLocalMode \|\| mockEnabled \|\| accountView\) return undefined;/u);
});

test("backend hardening migration adds hot-path RPCs, index, and execute ACLs", () => {
  const source = read("migrations/20260717013000_harden-backend-hot-paths.sql");
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.leaderboard_user_metadata/u);
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.upsert_tokentracker_telemetry_daily/u);
  assert.match(source, /CREATE INDEX IF NOT EXISTS tokentracker_user_badges_badge_id_idx/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.account_usage_grouped_v2/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.leaderboard_user_metadata/u);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.upsert_tokentracker_telemetry_daily/u);
});

test("unused direct profile-like table grants stay revoked", () => {
  const source = read("migrations/20260717015500_revoke-unused-profile-like-grants.sql");
  assert.match(
    source,
    /REVOKE ALL ON public\.tokentracker_profile_likes FROM anon, authenticated;/u,
  );
});
