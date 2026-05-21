# Mac App OAuth Callback Bug Investigation

Status: investigation note only. No code fix is included in this change.

## User-visible symptoms

- After signing in with Google from the macOS app, the OAuth callback page can show
  "Sign-in incomplete. Please try again." instead of the success/returning state.
- The callback page's "Close this page" button does not close the macOS app window.
- Closing the macOS dashboard window with the red window control and then choosing
  "Open Dashboard" from the menu bar popover can reopen the same failed callback
  page instead of the dashboard.
- High impact: after the macOS dashboard window is open, clicking another
  application may fail to bring that other application visually in front. The
  TokenTracker dashboard can remain the visible frontmost window, effectively
  blocking normal app switching.

## Expected macOS app flow

The macOS app login flow is not the same as the normal web flow:

1. The dashboard runs in a `WKWebView`.
2. `signInWithOAuth()` creates a PKCE verifier in that WebView session.
3. The app opens the provider auth URL in the system browser.
4. The system browser lands on `/auth/callback?insforge_code=...`.
5. The callback page should detect the pending native flow and redirect to
   `tokentracker://auth/callback?insforge_code=...`.
6. The app receives the deep link and loads `/auth/callback?insforge_code=...`
   back inside the original `WKWebView`.
7. The InsForge SDK exchanges the code using the PKCE verifier stored in the
   WebView's `sessionStorage`, then the dashboard becomes signed in.

If the code is exchanged in the system browser instead of the original WebView,
the exchange is expected to fail because the PKCE verifier lives in the WebView
session, not in the browser session.

## Relevant code paths

- `dashboard/src/contexts/InsforgeAuthContext.jsx`
  - Native app OAuth uses `window.webkit.messageHandlers.nativeOAuth`.
  - It calls `client.auth.signInWithOAuth({ skipBrowserRedirect: true })`.
  - It then best-effort marks the next callback as native through
    `PUT /api/auth-bridge/verifier`.
  - If this marker write fails, the error is swallowed and OAuth continues.

- `src/lib/local-api.js`
  - `/api/auth-bridge/verifier` stores an in-memory `_nativeAuthPending` flag.
  - The flag has a five-minute TTL.
  - `GET /api/auth-bridge/verifier` is a one-time read and clears the flag.

- `dashboard/src/pages/NativeAuthCallbackPage.jsx`
  - Captures `insforge_code` at module load time.
  - Fetches `/api/auth-bridge/verifier` to decide native vs web flow.
  - Native flow shows success/returning state and redirects to
    `tokentracker://auth/callback?insforge_code=...`.
  - Web flow waits for `signedIn`; if it never becomes true, it shows the
    "Sign-in incomplete" state.
  - The close button only calls `window.close()`.

- `TokenTrackerBar/TokenTrackerBar/Services/DashboardWindowController.swift`
  - The `nativeOAuth` handler opens the OAuth URL in the system browser.
  - `handleAuthCallback(code:)` loads `/auth/callback?insforge_code=...` in the
    app WebView so the SDK can exchange the code in the correct session.
  - `showWindow()` reuses the existing `NSWindow`/`WKWebView` if present.
  - `showWindow()` switches the app to `.regular`, calls
    `window.makeKeyAndOrderFront(nil)`, then force-activates with
    `NSApp.activate(ignoringOtherApps: true)`.
  - `windowWillClose` intentionally keeps the WebView and window alive to
    preserve cookies and login state.

- `dashboard/node_modules/@insforge/sdk/dist/index.mjs`
  - The SDK stores the PKCE verifier under `insforge_pkce_verifier` in
    `sessionStorage`.
  - `exchangeOAuthCode()` fails when the verifier is missing.
  - `detectAuthCallback()` removes `insforge_code` from the URL before exchanging
    the code.

## Current root-cause hypothesis

There appear to be two separate issues:

1. The native OAuth bridge can lose or miss the native callback marker.
   When that happens, the system browser callback page treats the request as a
   normal web login. It cannot complete the PKCE exchange because the verifier
   was created in the app WebView, so the page eventually falls into the
   "Sign-in incomplete" state.

2. The failed callback page is sticky in the macOS app window.
   The red close button closes/hides the `NSWindow`, but the existing
   `WKWebView` is preserved. Later, "Open Dashboard" calls `showWindow()`, which
   reuses the same WebView without navigating back to `/?app=1` or `/dashboard`.
   Therefore the old `/auth/callback` failure page is shown again.

3. The dashboard window may not yield correctly to other macOS apps.
   The current window-opening path force-activates TokenTracker with
   `NSApp.activate(ignoringOtherApps: true)`. There is no matching app
   deactivation handler in the inspected code path that orders the dashboard
   behind, hides it, or restores accessory behavior when the user clicks another
   app. Although no explicit floating window level was found in
   `DashboardWindowController`, this symptom should be treated as a severe
   window-lifecycle regression because it can make other apps appear
   inaccessible behind the dashboard.

The "Close this page" button on the callback page is also not sufficient for the
macOS app because `window.close()` does not close the native `NSWindow`. It is
also unreliable in normal browsers unless the page was opened by script.

## Suggested verification before fixing

- In the macOS app, inspect whether `PUT /api/auth-bridge/verifier` succeeds
  before the system browser opens.
- Confirm whether the system browser callback receives
  `{ "native": true }` from `GET /api/auth-bridge/verifier`.
- Confirm whether the failed callback page logs the SDK error
  `PKCE_VERIFIER_MISSING`.
- Confirm that reopening from the menu bar calls `showWindow()` on an existing
  window and does not reload `Constants.serverBaseURL + "?app=1"`.
- With the dashboard window open, click another app and inspect whether
  TokenTracker remains visually above the target app even after losing key
  status.
- Check the runtime `NSWindow.level`, activation policy, and key/main window
  state before and after clicking another app.
- Verify whether adding or restoring an app-deactivation/window-ordering path is
  needed, or whether the issue comes from a specific window level/state set
  outside `DashboardWindowController`.
