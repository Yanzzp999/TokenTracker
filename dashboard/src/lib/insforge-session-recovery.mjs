const OAUTH_CALLBACK_SETTLE_MS = 150;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canRecoverSession(error) {
  if (!error) return true;
  const status = Number(error.statusCode ?? error.status);
  return status === 401 || status === 403;
}

/**
 * Restore a session after a fresh embedded-browser launch.
 *
 * InsForge normally restores a valid httpOnly session cookie from
 * getCurrentUser(). On macOS, the dashboard WebView is intentionally released
 * when its window closes, so a restart can begin with no WebView cookies even
 * though the local API still holds its persisted refresh token. In that narrow
 * recovery path, explicitly call refreshSession() once so the local API can
 * mint and relay a new browser session.
 */
export async function restoreInsforgeUser(auth, options = {}) {
  const settleDelayMs = Math.max(0, Number(options.settleDelayMs ?? OAUTH_CALLBACK_SETTLE_MS) || 0);
  const wait = options.wait ?? delay;
  const isActive = options.isActive ?? (() => true);

  let current = await auth.getCurrentUser();
  if (current?.data?.user || !canRecoverSession(current?.error)) return current;
  if (!isActive()) return current;

  // Preserve the OAuth callback race workaround before attempting recovery.
  if (!current?.error && settleDelayMs > 0) {
    await wait(settleDelayMs);
    if (!isActive()) return current;
    current = await auth.getCurrentUser();
    if (current?.data?.user || !canRecoverSession(current?.error)) return current;
  }

  if (!isActive()) return current;
  if (typeof auth.refreshSession !== "function") return current;
  const refreshed = await auth.refreshSession();
  if (refreshed?.error) return current;

  return auth.getCurrentUser();
}
