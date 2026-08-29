import { copy } from "./copy";

// Shared billing-cycle helpers for the subscription rows: the settings popover
// and the inline subscription bars on the Limits page render identical
// progress/remaining values from these functions.
//
// All calendar math runs in UTC on purpose: nextBillingAt is stored as a UTC
// ISO string, so deriving cycle bounds with local-time getters would make the
// same record render different progress depending on the viewer's time zone
// (and flip across DST transitions).

const DAY_MS = 86400000;

// Calendar months in UTC with day-of-month clamping, so Jan 31 + 1 month is
// Feb 28/29 (not Mar 2/3) and the anchor day never drifts across cycles.
export function addMonthsUtc(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()),
  );
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.getTime();
}

function cycleStartMs(endMs, cycle) {
  if (cycle === "weekly") return endMs - 7 * DAY_MS;
  if (cycle === "yearly") return addMonthsUtc(endMs, -12);
  // Monthly: the calendar month ending at endMs, day clamped so Mar 31 maps
  // back to Feb 28/29 instead of rolling into March.
  const end = new Date(endMs);
  const daysInPrevMonth = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0),
  ).getUTCDate();
  const start = new Date(
    Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth() - 1,
      1,
      end.getUTCHours(),
      end.getUTCMinutes(),
    ),
  );
  start.setUTCDate(Math.min(end.getUTCDate(), daysInPrevMonth));
  return start.getTime();
}

// Inverse of cycleStartMs: the first cycle boundary after the subscription
// date. The settings form collects the subscription date and stores the
// derived boundary as the record's nextBillingAt anchor.
export function cycleEndFromStart(startMs, cycle) {
  if (cycle === "weekly") return startMs + 7 * DAY_MS;
  if (cycle === "yearly") return addMonthsUtc(startMs, 12);
  return addMonthsUtc(startMs, 1);
}

export function cycleStartOf(subscription) {
  // Prefer the persisted anchor: it is the user-entered subscription date and
  // survives month-end clamping (Jan 31 stays Jan 31 across cycles).
  if (subscription.startedAt != null) {
    const startedMs = new Date(subscription.startedAt).getTime();
    if (Number.isFinite(startedMs)) return startedMs;
  }
  return cycleStartMs(new Date(subscription.nextBillingAt).getTime(), subscription.cycle);
}

// The billing anchor a record's cycles are derived from. Records that carry
// an explicit startedAt use it directly; legacy records (created before the
// field existed) fall back to the cycle start implied by their stored
// boundary, which reproduces the previous rolling behaviour exactly.
function billingAnchorMs(subscription, cycle, recordedEndMs) {
  if (subscription.startedAt != null) {
    const startedMs = new Date(subscription.startedAt).getTime();
    if (Number.isFinite(startedMs)) return startedMs;
  }
  return cycleStartMs(recordedEndMs, cycle);
}

// The cycle window containing `now`, counted in whole cycles from the anchor:
// cycle k spans [anchor + k cycles, anchor + (k+1) cycles). Counting from a
// stable anchor keeps month-end anchors intact (Jan 31 → Feb 28 → Mar 31)
// where rolling the boundary forward would drift to the 28th permanently.
function currentCycleWindow(anchorMs, cycle, now) {
  if (cycle === "weekly") {
    const span = 7 * DAY_MS;
    const index = now <= anchorMs ? 0 : Math.floor((now - anchorMs) / span);
    return {
      startMs: anchorMs + index * span,
      endMs: anchorMs + (index + 1) * span,
    };
  }
  const step = cycle === "yearly" ? 12 : 1;
  const avgStepMs = step * 30.436875 * DAY_MS;
  let index = now <= anchorMs ? 0 : Math.floor((now - anchorMs) / avgStepMs);
  // The average-length estimate can land on either side of the true cycle
  // around month-end clamping; walk onto the cycle containing `now`.
  while (index > 0 && addMonthsUtc(anchorMs, index * step) > now) index -= 1;
  // Bounded for safety; a record millennia in the past still terminates.
  let guard = 0;
  while (addMonthsUtc(anchorMs, (index + 1) * step) <= now && guard < 12000) {
    index += 1;
    guard += 1;
  }
  return {
    startMs: addMonthsUtc(anchorMs, index * step),
    endMs: addMonthsUtc(anchorMs, (index + 1) * step),
  };
}

// The cycle a subscription is currently in, derived from its billing anchor
// (the persisted subscription date, or the implied start for legacy records).
// Auto-renew subscriptions always land on the cycle containing now, so a
// stale recorded renewal never renders as a permanently red 100% bar
// contradicting its own "Auto-renew" badge, and month-end anchors survive
// clamped months (Jan 31 → Feb 28 → Mar 31). Non-renewing records stop at
// their first boundary — `expired` is true only there.
export function cycleView(subscription, now) {
  const recordedEndMs = new Date(subscription.nextBillingAt).getTime();
  if (!Number.isFinite(recordedEndMs)) return null;
  const cycle = ["weekly", "monthly", "yearly"].includes(subscription.cycle)
    ? subscription.cycle
    : "monthly";

  const anchorMs = billingAnchorMs(subscription, cycle, recordedEndMs);
  if (!Number.isFinite(anchorMs)) return null;

  let startMs;
  let endMs;
  let expired = false;
  if (subscription.autoRenew) {
    ({ startMs, endMs } = currentCycleWindow(anchorMs, cycle, now));
  } else if (subscription.startedAt != null) {
    // New record with an explicit anchor: the first boundary after the
    // anchor is the final expiry.
    startMs = anchorMs;
    endMs = cycleEndFromStart(anchorMs, cycle);
    expired = endMs <= now;
  } else {
    // Legacy record without an anchor: the stored boundary is authoritative
    // (cycleStartMs is not invertible across clamped month-ends, so deriving
    // it back from the anchor could shift a Mar 31 expiry to Mar 28).
    startMs = anchorMs;
    endMs = recordedEndMs;
    expired = endMs <= now;
  }

  const span = Math.max(1, endMs - startMs);
  const progress = expired
    ? 1
    : Math.max(0, Math.min(1, (now - startMs) / span));
  return {
    endMs,
    startMs,
    progress,
    cycleDays: Math.max(1, Math.round(span / DAY_MS)),
    expired,
  };
}

// Compact right-hand label, same vocabulary as the limits bar ("6d", "17h").
// Deliberately locale-independent: the shared time keys translate to verbose
// past-tense strings ("X天前"), which is wrong for a remaining duration.
// Takes the effective end (already rolled for auto-renew) from cycleView.
export function remainingLabel(endMs, now) {
  const diff = endMs - now;
  if (diff <= 0) return copy("subscriptions.expired");
  const totalMinutes = Math.ceil(diff / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

export function countdownText(endMs, now) {
  const diff = endMs - now;
  if (diff <= 0) return copy("subscriptions.expired");
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return copy("subscriptions.countdown", { days, hours, minutes });
}
