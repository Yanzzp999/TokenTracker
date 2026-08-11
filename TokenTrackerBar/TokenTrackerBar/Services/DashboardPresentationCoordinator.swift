import AppKit

/// Owns the app-level presentation contract for the Dashboard window.
///
/// `DashboardWindowController` owns the `NSWindow`; this coordinator owns the
/// process-wide activation policy and the Dock tile. Keeping those roles apart
/// prevents individual close paths from drifting apart.
@MainActor
final class DashboardPresentationCoordinator {
    static let shared = DashboardPresentationCoordinator()

    private var policy = DashboardPresentationPolicy()

    private init() {}

    func showDashboard() {
        apply(policy.presentDashboard())
    }

    /// Cmd+Q and any future explicit "Close Dashboard" action use the same
    /// `windowShouldClose` path as the traffic-light close button.
    @discardableResult
    func closeDashboard() -> Bool {
        DashboardWindowController.shared.closeWindow()
    }

    /// Called by the Dashboard window delegate before AppKit starts closing it.
    func dashboardWindowShouldClose() -> Bool {
        apply(policy.prepareToCloseDashboard())
        return true
    }

    /// Called from AppKit's `windowWillClose`. Complete the state transition on
    /// the next main-loop turn, while guarding a concurrent reopen. This never
    /// hides `NSApp`, because the Dynamic Island and desktop pet are independent
    /// panels that must remain visible after the Dashboard closes.
    func dashboardWindowWillClose() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.apply(self.policy.completeDashboardClose())
        }
    }

    /// A real quit must not be converted into a menu-bar transition.
    func prepareForTermination() {
        policy.beginTermination()
    }

    private func apply(_ commands: [DashboardPresentationCommand]) {
        for command in commands {
            switch command {
            case .useRegularActivationPolicy:
                NSApp.setActivationPolicy(.regular)
            case .useAccessoryActivationPolicy:
                NSApp.setActivationPolicy(.accessory)
            case .showDashboardWindow:
                DashboardWindowController.shared.presentWindow()
            }
        }
    }
}
