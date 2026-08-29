import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Clock, Infinity, Plus } from "lucide-react";
import { copy, getCopyLocale } from "../../../lib/copy";
import { Button, ConfirmModal, Input, Select } from "../../components";
import { ProviderIcon } from "./ProviderIcon.jsx";
import {
  countdownText,
  cycleEndFromStart,
  cycleStartOf,
  cycleView,
  remainingLabel,
} from "../../../lib/subscription-display";
import {
  LIMIT_PROVIDER_IDS,
  limitProviderIconKey,
  limitProviderName,
} from "../../../lib/limits-providers.js";
import {
  createSubscription,
  deleteSubscription,
  updateSubscription,
} from "../../../lib/subscription-manager-api";

const EMPTY_FORM = {
  plan: "",
  provider: "",
  cycle: "monthly",
  autoRenew: true,
  startedAt: "",
};

// datetime-local values are local-time; the stored record is UTC. This is the
// display side of the round trip (openEdit → input → new Date() on submit).
export function toDatetimeLocalValue(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Subscription settings card rendered inside the Limits header popover.
 * Controlled by the parent (which fetches the list and refreshes after
 * mutations); this component only owns form / delete / expand local state.
 */
export function SubscriptionSettingsCard({ subscriptions, onChanged }) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(false);
  const [providerError, setProviderError] = useState(false);
  const [providerTaken, setProviderTaken] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const formRef = useRef(null);

  const copyLocale = getCopyLocale();
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(copyLocale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [copyLocale],
  );

  // Refresh countdowns/remaining labels once a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Bring the in-place form into view when it opens: the add form sits at
  // the end of the list and the edit form expands below its row, so either
  // can land outside the visible part of the scrollable popover. Smooth
  // scrolled unless the system asks for reduced motion.
  useEffect(() => {
    if (!formOpen) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    formRef.current?.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }, [formOpen, editingId]);

  const providerOptions = useMemo(
    () =>
      LIMIT_PROVIDER_IDS.map((id) => {
        // One subscription per tool: tools that already have a record are
        // disabled in the picker so the clash never happens. The record
        // being edited keeps its own tool selectable.
        const taken = (subscriptions || []).some(
          (subscription) => subscription.provider === id && subscription.id !== editingId,
        );
        const name = limitProviderName(id);
        return {
          value: id,
          label: taken ? `${name} ${copy("subscriptions.form.provider_taken_suffix")}` : name,
          disabled: taken,
        };
      }),
    [copyLocale, subscriptions, editingId],
  );

  const cycleOptions = useMemo(
    () => [
      { value: "weekly", label: copy("subscriptions.form.cycle_weekly") },
      { value: "monthly", label: copy("subscriptions.form.cycle_monthly") },
      { value: "yearly", label: copy("subscriptions.form.cycle_yearly") },
    ],
    [copyLocale],
  );

  const autoRenewOptions = useMemo(
    () => [
      { value: "true", label: copy("subscriptions.form.auto_renew_on") },
      { value: "false", label: copy("subscriptions.form.auto_renew_off") },
    ],
    [copyLocale],
  );

  const openAdd = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(false);
    setProviderError(false);
    setProviderTaken(false);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((subscription) => {
    setForm({
      plan: subscription.plan || "",
      provider: subscription.provider || "",
      cycle: subscription.cycle || "monthly",
      autoRenew: subscription.autoRenew,
      // The form collects the subscription date; derive it from the stored
      // billing anchor so editing starts from the day the plan began.
      startedAt: toDatetimeLocalValue(
        new Date(cycleStartOf(subscription)).toISOString(),
      ),
    });
    setEditingId(subscription.id);
    setFormError(false);
    setProviderError(false);
    setProviderTaken(false);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(false);
    setProviderError(false);
    setProviderTaken(false);
  }, []);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setFormError(false);
      // The linked tool doubles as the subscription name, so it is mandatory.
      if (!form.provider) {
        setProviderError(true);
        return;
      }
      // One subscription per tool: an account can only hold one active plan,
      // so the record represents the tool's current subscription. Editing a
      // record keeps its own provider exempt from this check.
      const duplicate = (subscriptions || []).some(
        (subscription) => subscription.provider === form.provider && subscription.id !== editingId,
      );
      if (duplicate) {
        setProviderTaken(true);
        return;
      }
      const startMs = new Date(form.startedAt).getTime();
      if (!Number.isFinite(startMs)) {
        setFormError(true);
        return;
      }
      const payload = {
        service: limitProviderName(form.provider),
        plan: form.plan,
        provider: form.provider || null,
        autoRenew: form.autoRenew,
        cycle: form.cycle,
        // Persist the user-entered anchor alongside the derived boundary so
        // month-end anchors survive clamped cycles (Jan 31 → Feb 28 → Mar 31).
        startedAt: startMs,
        nextBillingAt: cycleEndFromStart(startMs, form.cycle),
      };
      setSaving(true);
      try {
        if (editingId) {
          await updateSubscription(editingId, payload);
        } else {
          await createSubscription(payload);
        }
        closeForm();
        await onChanged?.();
      } catch (_e) {
        setFormError(true);
      } finally {
        setSaving(false);
      }
    },
    [closeForm, editingId, form, onChanged, subscriptions],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      await deleteSubscription(pendingDelete.id);
      if (pendingDelete.id === editingId) closeForm();
      setPendingDelete(null);
      await onChanged?.();
    } catch (_e) {
      // Keep the dialog open with a visible error: silently closing it
      // would look exactly like a successful delete.
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  }, [closeForm, editingId, onChanged, pendingDelete]);

  const list = subscriptions || [];

  // The form is rendered in place: below the row being edited, or as the
  // last list entry when adding. Kept as one node so both spots share the
  // exact same fields and behavior.
  const renderForm = () => {
    const editingSub = editingId ? list.find((item) => item.id === editingId) : null;
    const editingView = editingSub ? cycleView(editingSub, now) : null;
    return (
      <form ref={formRef} onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 px-3 py-3 text-left sm:grid-cols-2">
      <div className="flex items-center justify-between sm:col-span-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
          {editingId ? copy("subscriptions.edit") : copy("subscriptions.add")}
        </span>
      </div>
      {editingView ? (
        <div className="sm:col-span-2 rounded-md bg-oai-gray-50 dark:bg-oai-gray-800/50 px-2.5 py-2 text-xs text-oai-gray-600 dark:text-oai-gray-300">
          <span className="text-oai-gray-400 dark:text-oai-gray-500">
            {editingSub.autoRenew ? copy("subscriptions.label.renews_at") : copy("subscriptions.label.expires_at")}
          </span>{" "}
          <span className="font-mono tabular-nums">{dateFormat.format(new Date(editingView.endMs))}</span>
          {" · "}
          <span className={editingView.expired ? "text-oai-error" : undefined}>{countdownText(editingView.endMs, now)}</span>
        </div>
      ) : null}
          <div className="flex flex-col sm:col-span-1">
            <label
              htmlFor="subscription-provider"
              className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5"
            >
              {copy("subscriptions.form.provider")}
            </label>
            <Select
              id="subscription-provider"
              value={form.provider}
              onValueChange={(value) => setForm({ ...form, provider: String(value) })}
              options={providerOptions}
              matchTriggerWidth
              className="h-10 w-full px-3 text-sm"
            />
          </div>
          <div className="sm:col-span-1">
            <Input
              label={copy("subscriptions.form.plan")}
              value={form.plan}
              maxLength={120}
              placeholder={copy("subscriptions.form.plan_placeholder")}
              onChange={(event) => setForm({ ...form, plan: event.target.value })}
            />
          </div>
          <div className="flex flex-col sm:col-span-1">
            <label
              htmlFor="subscription-cycle"
              className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5"
            >
              {copy("subscriptions.form.cycle")}
            </label>
            <Select
              id="subscription-cycle"
              value={form.cycle}
              onValueChange={(value) => setForm({ ...form, cycle: String(value) })}
              options={cycleOptions}
              matchTriggerWidth
              className="h-10 w-full px-3 text-sm"
            />
          </div>
          <div className="flex flex-col sm:col-span-1">
            <label
              htmlFor="subscription-auto-renew"
              className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5"
            >
              {copy("subscriptions.form.auto_renew")}
            </label>
            <Select
              id="subscription-auto-renew"
              value={String(form.autoRenew)}
              onValueChange={(value) => setForm({ ...form, autoRenew: value === "true" })}
              options={autoRenewOptions}
              matchTriggerWidth
              className="h-10 w-full px-3 text-sm"
            />
          </div>
          <div className="sm:col-span-2">
            <Input
              label={copy("subscriptions.form.started_at")}
              type="datetime-local"
              value={form.startedAt}
              required
              onChange={(event) => setForm({ ...form, startedAt: event.target.value })}
            />
          </div>
          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            {editingId ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const target = list.find((item) => item.id === editingId);
                  if (target) setPendingDelete(target);
                }}
                className="!text-red-600 dark:!text-red-400 mr-auto"
              >
                {copy("subscriptions.delete")}
              </Button>
            ) : null}
            {providerError ? (
              <p className="mr-auto text-sm text-oai-error" role="alert">
                {copy("subscriptions.form.provider_required")}
              </p>
            ) : null}
            {providerTaken ? (
              <p className="mr-auto text-sm text-oai-error" role="alert">
                {copy("subscriptions.form.provider_taken")}
              </p>
            ) : null}
            {formError ? (
              <p className="mr-auto text-sm text-oai-error" role="alert">
                {copy("subscriptions.form.error")}
              </p>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={closeForm}>
              {copy("shared.action.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {copy("subscriptions.save")}
            </Button>
          </div>
      </form>
    );
  };

  return (
    <div className="flex max-h-[min(80vh,42rem)] w-[min(92vw,32rem)] flex-col gap-3 overflow-y-auto rounded-xl border border-oai-gray-200 bg-white p-4 shadow-lg dark:border-oai-gray-700 dark:bg-oai-gray-900">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="block truncate text-sm font-semibold text-oai-black dark:text-white">
            {copy("limits.page.openSubscriptions")}
          </span>
        </div>
        <Button type="button" size="sm" onClick={openAdd} className="shrink-0 gap-1.5">
          <Plus size={14} strokeWidth={2} aria-hidden />
          <span>{copy("subscriptions.add")}</span>
        </Button>
      </div>

      {list.length === 0 && !(formOpen && !editingId) ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center dark:border-oai-gray-700">
          <CalendarClock className="h-6 w-6 text-oai-gray-300 dark:text-oai-gray-600 mb-2" aria-hidden />
          <p className="text-sm font-medium text-oai-black dark:text-white">
            {copy("subscriptions.empty.title")}
          </p>
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("subscriptions.empty.body")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {/* No height cap here: the in-place form expands inside a list item,
              and the popover card above already caps at min(80vh, 42rem) with
              its own overflow scrolling. */}
          {list.map((subscription) => {
            const view = cycleView(subscription, now);
            if (!view) return null;
            const { endMs, expired } = view;
            const widthPct = expired ? 100 : view.progress * 100;
            const nearExpiry = !expired && endMs - now <= 3 * 86400000;
            const expanded = expandedId === subscription.id;
            return (
              <li key={subscription.id} className="rounded-lg border border-oai-gray-100 dark:border-oai-gray-800">
                <button
                  type="button"
                  onClick={() => openEdit(subscription)}
                  aria-label={`${copy("subscriptions.edit")} ${subscription.service}`}
                  aria-expanded={editingId === subscription.id}
                  className="w-full flex flex-col gap-1.5 px-3 py-2.5 text-left cursor-pointer hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/40 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <ProviderIcon provider={limitProviderIconKey(subscription.provider) || "OTHER"} size={14} />
                    <span className="text-sm font-medium text-oai-black dark:text-white truncate">
                      {subscription.service}
                    </span>
                    <span
                      role="img"
                      aria-label={
                        subscription.autoRenew
                          ? copy("subscriptions.badge.auto_renew")
                          : copy("subscriptions.badge.stops")
                      }
                      title={
                        subscription.autoRenew
                          ? copy("subscriptions.badge.auto_renew")
                          : copy("subscriptions.badge.stops")
                      }
                      className={`inline-flex shrink-0 translate-y-px ${
                        subscription.autoRenew
                          ? "text-oai-brand-600 dark:text-oai-brand-400"
                          : "text-blue-600 dark:text-blue-400"
                      }`}
                    >
                      {subscription.autoRenew ? (
                        <Infinity size={14} strokeWidth={2} aria-hidden />
                      ) : (
                        <Clock size={14} strokeWidth={2} aria-hidden />
                      )}
                    </span>
                    {subscription.plan ? (
                      <span className="text-xs rounded-full border border-oai-gray-200 dark:border-oai-gray-700 px-2 py-0.5 text-oai-gray-500 dark:text-oai-gray-400 shrink-0">
                        {subscription.plan}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] text-oai-gray-500 dark:text-oai-gray-400 shrink-0">
                      {copy("subscriptions.inline.label")}
                    </span>
                    <span className="relative flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1 overflow-hidden">
                      <span
                        className={`${
                          expired ? "bg-red-500" : nearExpiry ? "bg-amber-500" : "bg-blue-500"
                        } rounded-full h-full block transition-[width] duration-500 ease-out`}
                        style={{ width: `${widthPct}%`, minWidth: widthPct > 0 ? "3px" : 0 }}
                      />
                    </span>
                    <span
                      className={`text-[10px] tabular-nums shrink-0 ${
                        expired ? "text-oai-error" : "text-oai-gray-400 dark:text-oai-gray-500"
                      }`}
                    >
                      {remainingLabel(endMs, now)}
                    </span>
                  </span>
                </button>
                {editingId === subscription.id ? (
                  <div className="border-t border-oai-gray-100 dark:border-oai-gray-800">
                    {renderForm()}
                  </div>
                ) : null}
                {editingId !== subscription.id && expanded ? (
                  <div className="px-3 pb-3 flex flex-col gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800">
                    <p className="pt-2 text-xs text-oai-gray-600 dark:text-oai-gray-300">
                      <span className="text-oai-gray-400 dark:text-oai-gray-500">
                        {subscription.autoRenew
                          ? copy("subscriptions.label.renews_at")
                          : copy("subscriptions.label.expires_at")}
                      </span>{" "}
                      <span className="font-mono tabular-nums">
                        {dateFormat.format(new Date(endMs))}
                      </span>
                      {" · "}
                      <span className={expired ? "text-oai-error" : undefined}>
                        {countdownText(endMs, now)}
                      </span>
                      {" · "}
                      <span>
                        {subscription.autoRenew
                          ? copy("subscriptions.status.auto_renew")
                          : copy("subscriptions.status.manual")}
                      </span>
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(subscription)}
                      >
                        {copy("subscriptions.edit")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
          {formOpen && !editingId ? (
            <li className="rounded-lg border border-oai-gray-100 dark:border-oai-gray-800">
              {renderForm()}
            </li>
          ) : null}
        </ul>
      )}

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title={copy("subscriptions.confirm_delete_title")}
        description={pendingDelete?.service || ""}
        error={deleteError ? copy("subscriptions.delete_error") : null}
        confirmLabel={copy("subscriptions.delete")}
        cancelLabel={copy("shared.action.cancel")}
        destructive
        busy={deleting}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(false);
        }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
