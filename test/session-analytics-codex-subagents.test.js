"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseCodexRolloutFile } = require("../src/lib/codex-rollout-parser");
const {
  scanCodexSession,
  listSessionsForBrowser,
  providerRoots,
  summarizeSessions,
} = require("../src/lib/session-analytics");

function codexRow({
  id,
  parent = null,
  model = "gpt-5.6-sol",
  role = null,
  nickname = null,
  tokens = 0,
  cost = 0,
  startedAt = "2026-08-24T00:00:00.000Z",
}) {
  return {
    version: 12,
    session_hash: `hash-${id}`,
    session_id: id,
    parent_session_id: parent,
    agent_nickname: nickname,
    agent_role: role,
    source: "codex",
    project_key: "repo",
    project_ref: "/repo",
    model,
    started_at: startedAt,
    ended_at: startedAt,
    duration_ms: 1000,
    turns: 1,
    edit_turns: 0,
    retry_turns: 0,
    subagent_calls: 0,
    subagent_types: {},
    total_tokens: tokens,
    cost_usd: cost,
  };
}

test("Codex session roots honor CODEX_HOME only for the process home", () => {
  const processHome = path.resolve(os.tmpdir(), "tt-process-home");
  const customHome = path.resolve(os.tmpdir(), "tt-custom-home");
  const codexHome = path.resolve(os.tmpdir(), "tt-codex-home");
  const deps = {
    platform: "win32",
    homedir: () => processHome,
    probeWsl: false,
  };

  assert.deepEqual(
    providerRoots(processHome, ".codex", { CODEX_HOME: codexHome }, deps),
    [codexHome],
  );
  assert.deepEqual(
    providerRoots(customHome, ".codex", { CODEX_HOME: codexHome }, deps),
    [path.join(customHome, ".codex")],
  );
  assert.deepEqual(
    providerRoots(processHome, ".claude", { CODEX_HOME: codexHome }, deps),
    [path.join(processHome, ".claude")],
  );
});

test("custom CODEX_HOME rollouts load titles from the provider-root index", async () => {
  const providerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-custom-root-"));
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const rolloutDir = path.join(providerRoot, "sessions", "2026", "08", "27");
  const rolloutPath = path.join(rolloutDir, `rollout-${sessionId}.jsonl`);
  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.writeFile(path.join(providerRoot, "session_index.jsonl"), `${JSON.stringify({
    id: sessionId,
    thread_name: "Custom home title",
    updated_at: "2026-08-27T00:00:00.000Z",
  })}\n`, "utf8");
  await fs.writeFile(rolloutPath, `${[
    {
      timestamp: "2026-08-27T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: providerRoot },
    },
    {
      timestamp: "2026-08-27T00:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-08-27T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
      },
    },
  ].map(JSON.stringify).join("\n")}\n`, "utf8");

  const row = await scanCodexSession(rolloutPath);
  assert.equal(row.session_id, sessionId);
  assert.equal(row.title, "Custom home title");
});

test("Codex parser keeps the child lineage from the first session_meta row", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-codex-lineage-"));
  const filePath = path.join(dir, "rollout-child.jsonl");
  const rows = [
    {
      timestamp: "2026-08-24T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child",
        cwd: dir,
        forked_from_id: "root",
        parent_thread_id: "root",
        agent_nickname: "Hooke",
        agent_role: "sol",
        thread_source: "subagent",
      },
    },
    // Forked rollouts can replay the parent's metadata later in the file.
    {
      timestamp: "2026-08-24T00:00:01.000Z",
      type: "session_meta",
      payload: { id: "root", cwd: "/parent/repo" },
    },
  ];
  await fs.writeFile(filePath, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");

  const parsed = await parseCodexRolloutFile(filePath);
  assert.equal(parsed.sessionId, "child");
  assert.equal(parsed.cwd, dir);
  assert.equal(parsed.forkedFromId, "root");
  assert.equal(parsed.parentThreadId, "root");
  assert.equal(parsed.agentNickname, "Hooke");
  assert.equal(parsed.agentRole, "sol");
  assert.equal(parsed.threadSource, "subagent");
});

test("session browser exposes exact recursive Codex subagent totals", () => {
  const rows = [
    codexRow({ id: "root", tokens: 100, cost: 1 }),
    codexRow({ id: "child-sol", parent: "root", role: "sol", nickname: "Hooke", tokens: 40, cost: 0.4 }),
    codexRow({ id: "child-luna", parent: "root", model: "gpt-5.6-luna", role: "luna", nickname: "Bacon", tokens: 20, cost: 0.2 }),
    codexRow({ id: "grandchild", parent: "child-sol", role: "spark", nickname: "Euler", tokens: 10, cost: 0.1 }),
  ];

  const result = listSessionsForBrowser(rows);
  const get = (id) => result.sessions.find((row) => row.session_id === id);

  assert.equal(get("root").own_total_tokens, 100);
  assert.equal(get("root").subagent_total_tokens, 70);
  assert.equal(get("root").combined_total_tokens, 170);
  assert.equal(get("root").direct_subagent_count, 2);
  assert.equal(get("root").descendant_subagent_count, 3);
  assert.equal(get("child-sol").parent_session_hash, "hash-root");
  assert.equal(get("grandchild").root_session_hash, "hash-root");
  assert.equal(get("grandchild").agent_nickname, "Euler");
  // Authoritative per-session totals stay unchanged, so the ledger conserves.
  assert.equal(result.sessions.reduce((sum, row) => sum + row.total_tokens, 0), 170);
});

test("Codex subagent summaries use observed child rows and keep lineage local", () => {
  const rows = [
    {
      ...codexRow({ id: "root", tokens: 100 }),
      subagent_calls: 9,
      subagent_types: { spawn_agent: 9 },
      parent_link_conflict: false,
      orphaned_subagent: true,
    },
    codexRow({ id: "child", parent: "root", role: "luna", nickname: "Bacon", tokens: 25, cost: 0.2 }),
  ];

  const summary = summarizeSessions(rows);
  assert.deepEqual(summary.subagents, [{
    name: "luna",
    calls: 1,
    sessions: 1,
    total_tokens: 25,
    cost_usd: 0.2,
    attribution: "observed-child-session",
  }]);
  for (const row of summary.sessions) {
    for (const field of [
      "session_id",
      "parent_session_id",
      "parent_session_hash",
      "root_session_hash",
      "agent_nickname",
      "agent_role",
      "parent_link_conflict",
      "orphaned_subagent",
      "project_ref",
    ]) {
      assert.equal(field in row, false, `${field} must remain local-only`);
    }
  }
});

test("invalid Codex parent links never inflate combined totals", () => {
  const conflict = { ...codexRow({ id: "conflict", parent: "root", tokens: 30 }), parent_link_conflict: true };
  const cycleA = codexRow({ id: "cycle-a", parent: "cycle-b", tokens: 40 });
  const cycleB = codexRow({ id: "cycle-b", parent: "cycle-a", tokens: 50 });
  const orphan = codexRow({ id: "orphan", parent: "missing", tokens: 60 });
  const result = listSessionsForBrowser([
    codexRow({ id: "root", tokens: 100 }),
    conflict,
    cycleA,
    cycleB,
    orphan,
  ]);
  const get = (id) => result.sessions.find((row) => row.session_id === id);

  assert.equal(get("root").combined_total_tokens, 100);
  assert.equal(get("conflict").parent_session_hash, null);
  assert.equal(get("cycle-a").combined_total_tokens, 40);
  assert.equal(get("cycle-b").combined_total_tokens, 50);
  assert.equal(get("orphan").orphaned_subagent, true);
  assert.equal(get("orphan").combined_total_tokens, 60);
});
