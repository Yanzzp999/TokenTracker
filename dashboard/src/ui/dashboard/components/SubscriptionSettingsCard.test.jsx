import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubscription,
  deleteSubscription,
  updateSubscription,
} from "../../../lib/subscription-manager-api";
import { SubscriptionSettingsCard, toDatetimeLocalValue } from "./SubscriptionSettingsCard.jsx";

vi.mock("../../../lib/subscription-manager-api", () => ({
  createSubscription: vi.fn(),
  updateSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
}));

function makeSubscription(overrides = {}) {
  return {
    id: "sub-1",
    service: "GPT",
    plan: "Plus",
    provider: null,
    autoRenew: true,
    nextBillingAt: new Date(Date.now() + ((2 * 24 + 3) * 60 + 4) * 60000 + 30000).toISOString(),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  createSubscription.mockResolvedValue(makeSubscription());
  updateSubscription.mockResolvedValue(makeSubscription());
  deleteSubscription.mockResolvedValue({ removed: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("toDatetimeLocalValue", () => {
  it("round-trips stored UTC timestamps through the local datetime-local input", () => {
    // The stored record is UTC; the form input shows local wall time. Parsing
    // that value back must land on the same minute no matter which time zone
    // (or DST offset) the viewer sits in.
    const samples = [
      Date.UTC(2026, 7, 16, 6, 0),
      Date.UTC(2026, 2, 8, 7, 30), // US DST transition day
      Date.UTC(2026, 2, 29, 1, 15), // EU DST transition day
      Date.UTC(2026, 11, 31, 23, 59),
    ];
    for (const ms of samples) {
      const value = toDatetimeLocalValue(new Date(ms).toISOString());
      expect(new Date(value).getTime()).toBe(ms);
    }
  });

  it("returns an empty string for unparseable input", () => {
    expect(toDatetimeLocalValue("not a date")).toBe("");
  });
});

describe("SubscriptionSettingsCard", () => {
  it("shows the empty state when there are no subscriptions", () => {
    render(<SubscriptionSettingsCard subscriptions={[]} onChanged={vi.fn()} />);

    expect(screen.getByText("No subscriptions yet")).toBeInTheDocument();
    expect(screen.getByText("Add subscription")).toBeInTheDocument();
  });

  it("lists subscriptions and opens edit on click", () => {
    // Clicking a subscription row now directly enters edit (task 2) instead of
    // expanding a detail view. The edit form is rendered in place below the row.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 16, 12, 0, 0)));
    try {
      render(
        <SubscriptionSettingsCard
          subscriptions={[
            makeSubscription(),
            makeSubscription({
              id: "sub-2",
              service: "Claude",
              plan: null,
              autoRenew: false,
              nextBillingAt: new Date(Date.now() - 60 * 60000).toISOString(),
            }),
          ]}
          onChanged={vi.fn()}
        />,
      );

      expect(screen.getByText("GPT")).toBeInTheDocument();
      expect(screen.getByText("Plus")).toBeInTheDocument();
      expect(screen.getByText("Claude")).toBeInTheDocument();
      expect(screen.getByText("Expired")).toBeInTheDocument();

      fireEvent.click(screen.getByText("GPT"));
      expect(screen.getByLabelText("Linked tool")).toBeInTheDocument();
      expect(screen.getByLabelText("Plan")).toHaveValue("Plus");
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a subscription named after the linked tool and notifies the parent", async () => {
    const onChanged = vi.fn();
    render(<SubscriptionSettingsCard subscriptions={[]} onChanged={onChanged} />);

    fireEvent.click(screen.getByText("Add subscription"));
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "Plus" } });
    fireEvent.change(screen.getByLabelText("Subscription date"), {
      target: { value: "2026-08-16T14:00" },
    });
    // The linked-tool picker is the shared Base UI Select, so open the popup
    // and pick the option instead of firing a native change event. Base UI
    // ignores synthetic clicks on unhovered items, so press first like a real
    // pointer would. The tool choice also names the subscription — there is
    // no separate service field anymore.
    fireEvent.click(screen.getByLabelText("Linked tool"));
    const codexOption = await screen.findByRole("option", { name: "Codex" });
    fireEvent.pointerDown(codexOption, { pointerType: "mouse" });
    fireEvent.click(codexOption);

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(createSubscription).toHaveBeenCalledTimes(1);
    });
    expect(createSubscription).toHaveBeenCalledWith({
      service: "Codex",
      plan: "Plus",
      provider: "codex",
      cycle: "monthly",
      autoRenew: true,
      // The stored anchor is derived: subscription date + one cycle.
      startedAt: new Date("2026-08-16T14:00").getTime(),
      nextBillingAt: new Date("2026-09-16T14:00").getTime(),
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("clamps the derived anchor to the end of short months", () => {
    const onChanged = vi.fn();
    render(<SubscriptionSettingsCard subscriptions={[]} onChanged={onChanged} />);

    fireEvent.click(screen.getByText("Add subscription"));
    fireEvent.click(screen.getByLabelText("Linked tool"));
    const codexOption = screen.getByRole("option", { name: "Codex" });
    fireEvent.pointerDown(codexOption, { pointerType: "mouse" });
    fireEvent.click(codexOption);
    fireEvent.change(screen.getByLabelText("Subscription date"), {
      target: { value: "2026-01-31T10:00" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: new Date("2026-01-31T10:00").getTime(),
        nextBillingAt: new Date("2026-02-28T10:00").getTime(),
      }),
    );
  });

  it("refuses to save without a linked tool and explains why", () => {
    render(<SubscriptionSettingsCard subscriptions={[]} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByText("Add subscription"));
    fireEvent.change(screen.getByLabelText("Subscription date"), {
      target: { value: "2026-08-16T14:00" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(screen.getByRole("alert")).toHaveTextContent("Select a linked tool.");
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("disables taken tools in the picker, keeping the edited record's own tool selectable", () => {
    render(
      <SubscriptionSettingsCard
        subscriptions={[
          makeSubscription({ provider: "codex" }),
          makeSubscription({
            id: "sub-2",
            service: "Claude",
            plan: null,
            provider: "claude",
            autoRenew: false,
            nextBillingAt: new Date(Date.now() - 60 * 60000).toISOString(),
          }),
        ]}
        onChanged={vi.fn()}
      />,
    );

    // Adding: tools that already have a record are disabled and labelled.
    fireEvent.click(screen.getByText("Add subscription"));
    fireEvent.click(screen.getByLabelText("Linked tool"));
    expect(screen.getByRole("option", { name: "Codex (already subscribed)" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Claude (already subscribed)" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Cursor" })).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByText("Cancel"));

    // Editing: the record's own tool stays selectable while the other taken
    // tool remains off-limits. Clicking the row now directly opens edit.
    fireEvent.click(screen.getByText("GPT"));
    fireEvent.click(screen.getByLabelText("Linked tool"));
    expect(screen.getByRole("option", { name: "Codex" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: "Claude (already subscribed)" })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps allowing a record to keep its own tool when edited", async () => {
    const onChanged = vi.fn();
    render(
      <SubscriptionSettingsCard
        subscriptions={[makeSubscription({ provider: "codex" })]}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByText("GPT"));
    fireEvent.change(screen.getByLabelText("Subscription date"), {
      target: { value: "2026-08-16T14:00" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(updateSubscription).toHaveBeenCalledTimes(1);
    });
    expect(updateSubscription).toHaveBeenCalledWith("sub-1", {
      service: "Codex",
      plan: "Plus",
      provider: "codex",
      cycle: "monthly",
      autoRenew: true,
      startedAt: new Date("2026-08-16T14:00").getTime(),
      nextBillingAt: new Date("2026-09-16T14:00").getTime(),
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("opens the edit form in place below the edited row, keeping the row visible", () => {
    render(
      <SubscriptionSettingsCard
        subscriptions={[
          makeSubscription(),
          makeSubscription({
            id: "sub-2",
            service: "Claude",
            plan: null,
            autoRenew: false,
            nextBillingAt: new Date(Date.now() - 60 * 60000).toISOString(),
          }),
        ]}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("GPT"));

    // The form opens pre-filled and sits between the edited row and the next
    // list entry — not in a separate section above the list.
    expect(screen.getByLabelText("Plan")).toHaveValue("Plus");
    const gptRow = screen.getByText("GPT");
    const planField = screen.getByLabelText("Plan");
    const claudeRow = screen.getByText("Claude");
    expect(
      gptRow.compareDocumentPosition(planField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      planField.compareDocumentPosition(claudeRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the add form as the last entry of the list", () => {
    render(<SubscriptionSettingsCard subscriptions={[makeSubscription()]} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByText("Add subscription"));

    expect(
      screen
        .getByText("GPT")
        .compareDocumentPosition(screen.getByLabelText("Plan")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("prefills the edit form with the persisted startedAt anchor", () => {
    // Round-trip: opening the edit dialog must surface the original anchor
    // (Jan 31), not the clamped stored boundary (Feb 28).
    const record = makeSubscription({
      provider: "codex",
      startedAt: "2026-01-31T10:07:00.000Z",
      nextBillingAt: "2026-02-28T10:07:00.000Z",
    });
    render(<SubscriptionSettingsCard subscriptions={[record]} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByText("GPT"));

    const value = screen.getByLabelText("Subscription date").value;
    // datetime-local renders in local time; compare instants, not strings.
    expect(new Date(value).getTime()).toBe(Date.parse("2026-01-31T10:07:00.000Z"));
  });

  it("derives the prefill from the stored boundary for legacy records", () => {
    // Records created before startedAt existed: the implied cycle start
    // (Feb 28 for a Mar 31 boundary) is the best available anchor.
    const record = makeSubscription({
      provider: "codex",
      nextBillingAt: "2026-03-31T10:07:00.000Z",
    });
    render(<SubscriptionSettingsCard subscriptions={[record]} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByText("GPT"));

    const value = screen.getByLabelText("Subscription date").value;
    expect(new Date(value).getTime()).toBe(Date.parse("2026-02-28T10:07:00.000Z"));
  });

  it("deletes a subscription after confirmation and notifies the parent", async () => {
    const onChanged = vi.fn();
    render(
      <SubscriptionSettingsCard subscriptions={[makeSubscription()]} onChanged={onChanged} />,
    );

    fireEvent.click(screen.getByText("GPT"));
    fireEvent.click(screen.getByText("Delete"));

    const confirmButton = await screen.findAllByText("Delete");
    fireEvent.click(confirmButton[confirmButton.length - 1]);

    await waitFor(() => {
      expect(deleteSubscription).toHaveBeenCalledWith("sub-1");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
