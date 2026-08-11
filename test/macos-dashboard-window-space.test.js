const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const dashboardWindowControllerPath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "DashboardWindowController.swift",
);
const appDelegatePath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "TokenTrackerBarApp.swift",
);
const desktopPetWindowControllerPath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "DesktopPetWindowController.swift",
);
const dashboardPresentationCoordinatorPath = path.join(
  repoRoot,
  "TokenTrackerBar",
  "TokenTrackerBar",
  "Services",
  "DashboardPresentationCoordinator.swift",
);

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("macOS dashboard window can full-screen itself without joining other apps' full-screen spaces", () => {
  const source = read(dashboardWindowControllerPath);
  const behaviorMatch = source.match(/window\.collectionBehavior\s*=\s*\[([^\]]+)\]/);

  assert.ok(behaviorMatch, "Dashboard NSWindow should set an explicit collectionBehavior");

  const behavior = behaviorMatch[1];
  assert.match(behavior, /\.managed\b/, "Dashboard should participate in normal Spaces management");
  assert.match(behavior, /\.fullScreenPrimary\b/, "Dashboard should still be able to enter its own full-screen Space");
  assert.doesNotMatch(
    behavior,
    /\.canJoinAllSpaces|\.fullScreenAuxiliary|\.moveToActiveSpace/,
    "Dashboard should not float into or move to the currently active full-screen Space",
  );
  assert.doesNotMatch(
    source,
    /\.canJoinAllSpaces|\.fullScreenAuxiliary|\.moveToActiveSpace/,
    "DashboardWindowController should not add forbidden Space behavior elsewhere",
  );
});

test("macOS desktop pet keeps its intentional full-screen auxiliary behavior", () => {
  const source = read(desktopPetWindowControllerPath);
  const behaviorMatch = source.match(/panel\.collectionBehavior\s*=\s*\[([^\]]+)\]/);

  assert.ok(behaviorMatch, "Desktop pet NSPanel should set an explicit collectionBehavior");

  const behavior = behaviorMatch[1];
  assert.match(behavior, /\.canJoinAllSpaces\b/);
  assert.match(behavior, /\.fullScreenAuxiliary\b/);
});

test("reopening the macOS menu bar app always restores the dashboard", () => {
  const source = read(appDelegatePath);
  const reopenHandler = source.match(
    /func applicationShouldHandleReopen\([\s\S]*?\n    }/,
  )?.[0];

  assert.ok(reopenHandler, "AppDelegate should handle Finder/Dock reopen events");
  assert.match(reopenHandler, /DashboardPresentationCoordinator\.shared\.showDashboard\(\)/);
  assert.match(
    reopenHandler,
    /return false/,
    "The custom reopen handler should suppress AppKit's default untitled-window behavior",
  );
  assert.doesNotMatch(
    reopenHandler,
    /if\s+!?flag|guard\s+!?flag/,
    "Other visible utility windows must not suppress dashboard restoration",
  );
});

test("a normal macOS launch opens the dashboard but a login-item launch stays quiet", () => {
  const source = read(appDelegatePath);
  const launchHandler = source.match(
    /func applicationDidFinishLaunching\([\s\S]*?\n    }\n\n    func applicationWillTerminate/,
  )?.[0];

  assert.ok(launchHandler, "AppDelegate should configure initial launch behavior");
  assert.match(launchHandler, /keyAELaunchedAsLogInItem/);
  assert.match(launchHandler, /DashboardPresentationCoordinator\.shared\.showDashboard\(\)/);
});

test("Cmd+Q exits when no visible Dashboard close can begin", () => {
  const appDelegateSource = read(appDelegatePath);
  const coordinatorSource = read(dashboardPresentationCoordinatorPath);
  const dashboardWindowControllerSource = read(dashboardWindowControllerPath);
  const terminationHandler = appDelegateSource.match(
    /func applicationShouldTerminate\([\s\S]*?\n    }\n\n    func applicationShouldHandleReopen/,
  )?.[0];

  assert.ok(terminationHandler, "AppDelegate should handle Cmd+Q termination requests");
  assert.match(
    terminationHandler,
    /if DashboardPresentationCoordinator\.shared\.closeDashboard\(\) \{\s*return \.terminateCancel\s*}/,
    "Cmd+Q should be cancelled only after a visible Dashboard close begins",
  );
  assert.match(
    terminationHandler,
    /DashboardPresentationCoordinator\.shared\.prepareForTermination\(\)\s*return \.terminateNow/,
    "Cmd+Q should terminate when no Dashboard window exists or is already closed",
  );
  assert.match(
    coordinatorSource,
    /func closeDashboard\(\) -> Bool \{\s*DashboardWindowController\.shared\.closeWindow\(\)\s*}/,
  );
  assert.match(
    dashboardWindowControllerSource,
    /func closeWindow\(\) -> Bool \{\s*guard let window, window\.isVisible else \{ return false \}\s*window\.performClose\(nil\)\s*return true\s*}/,
    "A hidden or absent Dashboard must report that no close began",
  );
});
