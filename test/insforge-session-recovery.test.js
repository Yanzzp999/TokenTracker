const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

async function loadRecovery() {
  const url = pathToFileURL(
    path.join(process.cwd(), "dashboard/src/lib/insforge-session-recovery.mjs"),
  ).href;
  return import(url);
}

test("uses the existing user without refreshing", async () => {
  const { restoreInsforgeUser } = await loadRecovery();
  const user = { id: "existing-user" };
  const auth = {
    getCurrentUser: async () => ({ data: { user }, error: null }),
    refreshSession: async () => assert.fail("should not refresh an existing session"),
  };

  const result = await restoreInsforgeUser(auth, { settleDelayMs: 0 });
  assert.equal(result.data.user, user);
});

test("refreshes once when a new WebView has no session cookie", async () => {
  const { restoreInsforgeUser } = await loadRecovery();
  const user = { id: "restored-user" };
  let getCurrentUserCalls = 0;
  let refreshCalls = 0;
  const auth = {
    getCurrentUser: async () => {
      getCurrentUserCalls += 1;
      return getCurrentUserCalls === 3
        ? { data: { user }, error: null }
        : { data: { user: null }, error: null };
    },
    refreshSession: async () => {
      refreshCalls += 1;
      return { data: { accessToken: "restored-token" }, error: null };
    },
  };

  const result = await restoreInsforgeUser(auth, { settleDelayMs: 1, wait: async () => {} });
  assert.equal(result.data.user, user);
  assert.equal(getCurrentUserCalls, 3);
  assert.equal(refreshCalls, 1);
});

test("refreshes a recoverable unauthorized response without waiting", async () => {
  const { restoreInsforgeUser } = await loadRecovery();
  const user = { id: "renewed-user" };
  let getCurrentUserCalls = 0;
  let refreshCalls = 0;
  const auth = {
    getCurrentUser: async () => {
      getCurrentUserCalls += 1;
      return getCurrentUserCalls === 1
        ? { data: { user: null }, error: { statusCode: 401 } }
        : { data: { user }, error: null };
    },
    refreshSession: async () => {
      refreshCalls += 1;
      return { data: {}, error: null };
    },
  };

  const result = await restoreInsforgeUser(auth, {
    settleDelayMs: 150,
    wait: async () => assert.fail("should not wait before recovering a 401"),
  });
  assert.equal(result.data.user, user);
  assert.equal(getCurrentUserCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("does not turn a network failure into a refresh request", async () => {
  const { restoreInsforgeUser } = await loadRecovery();
  let refreshCalls = 0;
  const failure = { statusCode: 502, message: "upstream unavailable" };
  const auth = {
    getCurrentUser: async () => ({ data: { user: null }, error: failure }),
    refreshSession: async () => {
      refreshCalls += 1;
      return { data: {}, error: null };
    },
  };

  const result = await restoreInsforgeUser(auth, { settleDelayMs: 0 });
  assert.equal(result.error, failure);
  assert.equal(refreshCalls, 0);
});

test("does not refresh after the auth provider has been disposed", async () => {
  const { restoreInsforgeUser } = await loadRecovery();
  let refreshCalls = 0;
  const current = { data: { user: null }, error: null };
  const auth = {
    getCurrentUser: async () => current,
    refreshSession: async () => {
      refreshCalls += 1;
      return { data: {}, error: null };
    },
  };

  const result = await restoreInsforgeUser(auth, {
    settleDelayMs: 1,
    wait: async () => assert.fail("should not wait after disposal"),
    isActive: () => false,
  });
  assert.equal(result, current);
  assert.equal(refreshCalls, 0);
});
