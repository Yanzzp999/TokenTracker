import XCTest

final class DashboardPresentationPolicyTests: XCTestCase {
    func testPresentingDashboardPromotesMenuBarAgentToRegularApp() {
        var policy = DashboardPresentationPolicy()

        XCTAssertEqual(
            policy.presentDashboard(),
            [.useRegularActivationPolicy, .showDashboardWindow]
        )
        XCTAssertEqual(policy.state, .dashboard)
    }

    func testTrafficLightCloseDemotesBeforeTheWindowFinishesClosingWithoutHidingPanels() {
        var policy = DashboardPresentationPolicy()
        _ = policy.presentDashboard()

        XCTAssertEqual(policy.prepareToCloseDashboard(), [.useAccessoryActivationPolicy])
        XCTAssertEqual(policy.state, .dashboardClosing)
        XCTAssertEqual(policy.completeDashboardClose(), [])
        XCTAssertEqual(policy.state, .menuBar)
    }

    func testReopeningBeforeCloseCompletionDefersFreshWindowPresentation() {
        var policy = DashboardPresentationPolicy()
        _ = policy.presentDashboard()
        _ = policy.prepareToCloseDashboard()

        XCTAssertEqual(policy.presentDashboard(), [.useRegularActivationPolicy])
        XCTAssertEqual(
            policy.completeDashboardClose(),
            [.useRegularActivationPolicy, .showDashboardWindow]
        )
        XCTAssertEqual(policy.state, .dashboard)
    }

    func testTerminationDoesNotScheduleBackgroundPresentation() {
        var policy = DashboardPresentationPolicy()
        _ = policy.presentDashboard()

        policy.beginTermination()

        XCTAssertEqual(policy.state, .terminating)
        XCTAssertEqual(policy.prepareToCloseDashboard(), [])
        XCTAssertEqual(policy.completeDashboardClose(), [])
        XCTAssertEqual(policy.presentDashboard(), [])
    }
}
