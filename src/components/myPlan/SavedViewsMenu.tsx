import { useEffect, useRef, useState } from "react";
import type { SavedView, UserPreferences, ViewConfig } from "../../api/client";
import { cx } from "../../lib/classNames";
import { MAX_SAVED_VIEWS, sameViewConfig, type PreferencesUpdate } from "../../lib/userPreferences";
import PlanIcon from "./PlanIcons";
import { microLabelClass, popoverPanelClass, toolButtonClass } from "./planChrome";
import SaveViewForm, { type SaveViewOptions } from "./SaveViewForm";
import type { NotifyFn } from "./Toast";
import { useDismiss } from "./useDismiss";
import { START_AT_LABELS, createViewId, describeView } from "./viewConfig";

// "Views" menu (plan §2.8, SPEC E8): apply a saved view, save the current one
// (name + optional start pages), delete views, and see both start pages.
// Views are relative: they never store a date. Self-contained for reuse in
// the team headers.

export type SavedViewsMenuProps = {
  currentView: ViewConfig;
  prefs: UserPreferences;
  onUpdatePrefs: (update: PreferencesUpdate) => void;
  /** Apply scope/range/orientation/colorBy (see applyViewConfig). */
  onApplyView: (view: ViewConfig) => void;
  isMobile: boolean;
  onNotify?: NotifyFn;
};

/** Where focus goes once the menu step has rendered (the focused control may have unmounted). */
type FocusTarget = { kind: "first" } | { kind: "save" } | { kind: "view"; id: string };

function startPageText(view: ViewConfig | null, saved: SavedView[]): string {
  if (!view) return "Team (default)";
  const named = saved.find((item) => sameViewConfig(item, view));
  return named ? named.name : describeView(view);
}

export default function SavedViewsMenu({
  currentView,
  prefs,
  onUpdatePrefs,
  onApplyView,
  isMobile,
  onNotify,
}: SavedViewsMenuProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"menu" | "form">("menu");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<FocusTarget | null>(null);
  const views = prefs.savedViews;
  const full = views.length >= MAX_SAVED_VIEWS;

  // Opening the menu, returning from the form and deleting a row all remove
  // or reveal controls: move focus to a sensible one after the render.
  useEffect(() => {
    const target = focusTarget.current;
    if (!open || step !== "menu" || !target) return;
    focusTarget.current = null;
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-view-apply]") ?? []);
    const save = saveButtonRef.current && !saveButtonRef.current.disabled ? saveButtonRef.current : null;
    const row = target.kind === "view" ? rows.find((item) => item.dataset.viewApply === target.id) : undefined;
    const next = target.kind === "first" ? rows[0] ?? save : target.kind === "view" ? row ?? save : save;
    (next ?? panelRef.current?.querySelector<HTMLElement>("button"))?.focus();
  });

  useDismiss(
    open,
    (reason) => {
      setOpen(false);
      if (reason === "escape") buttonRef.current?.focus();
    },
    (target) => Boolean(rootRef.current?.contains(target)),
  );

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const save = ({ name, startAt, startDesktop, startMobile }: SaveViewOptions) => {
    const view: SavedView = { ...currentView, id: createViewId(), name, startAt };
    const before = {
      startViewDesktop: prefs.startViewDesktop,
      startViewMobile: prefs.startViewMobile,
    };
    onUpdatePrefs((prev) => ({
      ...prev,
      savedViews: [...prev.savedViews, view].slice(0, MAX_SAVED_VIEWS),
      startViewDesktop: startDesktop ? { ...currentView } : prev.startViewDesktop,
      startViewMobile: startMobile ? { ...currentView } : prev.startViewMobile,
    }));
    const starts = [startDesktop && "computers", startMobile && "phones"].filter(Boolean);
    const suffix = starts.length ? ` · start page on ${starts.join(" and ")}` : "";
    onNotify?.(`View "${name}" saved${suffix}`, {
      label: "Undo",
      onAction: () =>
        onUpdatePrefs((prev) => ({
          ...prev,
          ...before,
          savedViews: prev.savedViews.filter((item) => item.id !== view.id),
        })),
    });
    setStep("menu");
    close();
  };

  const remove = (view: SavedView) => {
    const index = views.findIndex((item) => item.id === view.id);
    const neighbour = views[index + 1] ?? views[index - 1];
    focusTarget.current = neighbour ? { kind: "view", id: neighbour.id } : { kind: "save" };
    onUpdatePrefs((prev) => ({
      ...prev,
      savedViews: prev.savedViews.filter((item) => item.id !== view.id),
    }));
    onNotify?.(`View "${view.name}" deleted`, {
      label: "Undo",
      onAction: () =>
        onUpdatePrefs((prev) => {
          if (prev.savedViews.some((item) => item.id === view.id)) return prev;
          const savedViews = [...prev.savedViews];
          savedViews.splice(Math.max(0, index), 0, view);
          return { ...prev, savedViews: savedViews.slice(0, MAX_SAVED_VIEWS) };
        }),
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setStep("menu");
          focusTarget.current = open ? null : { kind: "first" };
          setOpen((value) => !value);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={isMobile ? "Views" : undefined}
        title="Saved views and start pages"
        className={cx(
          toolButtonClass,
          isMobile ? "h-10 w-10" : "px-3.5",
          open && "ring-2 ring-sky-300 dark:ring-sky-400/60",
        )}
      >
        <PlanIcon name="bookmark" className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
        {isMobile ? null : "Views"}
      </button>
      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={step === "menu" ? "Views" : "Save current view"}
          className={cx(
            popoverPanelClass,
            "z-30 flex flex-col gap-3",
            isMobile
              ? "fixed inset-x-4 top-4 max-h-[calc(100vh-2rem)] overflow-y-auto"
              : "absolute right-0 top-full mt-2 w-[380px]",
          )}
        >
          {step === "form" ? (
            <SaveViewForm
              currentView={currentView}
              isMobile={isMobile}
              onBack={() => {
                focusTarget.current = { kind: "save" };
                setStep("menu");
              }}
              onSave={save}
            />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold">Views</h3>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="grid h-8 w-8 place-items-center rounded-full text-slate-600 focus-visible:rounded-full hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <PlanIcon name="x" />
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <span className={microLabelClass}>Saved views</span>
                {views.length === 0 ? (
                  <p className="py-2 text-[13px] text-slate-600 dark:text-slate-400">No saved views yet.</p>
                ) : (
                  <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
                    {views.map((view) => (
                      <SavedViewRow
                        key={view.id}
                        view={view}
                        isCurrent={sameViewConfig(view, currentView)}
                        isDesktopStart={sameViewConfig(view, prefs.startViewDesktop)}
                        isMobileStart={sameViewConfig(view, prefs.startViewMobile)}
                        onApply={() => {
                          onApplyView(view);
                          close();
                        }}
                        onDelete={() => remove(view)}
                      />
                    ))}
                  </ul>
                )}
              </div>
              <div className="h-px bg-slate-200 dark:bg-slate-700" />
              <button
                ref={saveButtonRef}
                type="button"
                disabled={full}
                onClick={() => setStep("form")}
                className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-slate-800"
              >
                <PlanIcon name="plus" />
                Save current view…
              </button>
              {full ? (
                <p className="-mt-2 px-3 text-xs text-slate-600 dark:text-slate-400">
                  Up to {MAX_SAVED_VIEWS} views. Delete one to save another.
                </p>
              ) : null}
              <div className="flex flex-col gap-1.5 text-[13px] text-slate-700 dark:text-slate-300">
                <span className={microLabelClass}>Start pages</span>
                <span className="flex items-center gap-2">
                  <PlanIcon name="monitor" className="h-4 w-4 shrink-0" />
                  Computer: {startPageText(prefs.startViewDesktop, views)}
                </span>
                <span className="flex items-center gap-2">
                  <PlanIcon name="smartphone" className="h-4 w-4 shrink-0" />
                  Phone: {startPageText(prefs.startViewMobile, views)}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Views never store a date: they open relative to today. Use the star to make the
                current view your start page.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

type SavedViewRowProps = {
  view: SavedView;
  isCurrent: boolean;
  isDesktopStart: boolean;
  isMobileStart: boolean;
  onApply: () => void;
  onDelete: () => void;
};

function SavedViewRow({ view, isCurrent, isDesktopStart, isMobileStart, onApply, onDelete }: SavedViewRowProps) {
  return (
    <li className="flex items-center gap-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800">
      <button
        type="button"
        data-view-apply={view.id}
        onClick={onApply}
        aria-current={isCurrent ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{view.name}</span>
          <span className="truncate text-xs text-slate-600 dark:text-slate-400">
            {describeView(view)}
            {view.startAt !== "today" ? ` · opens at ${START_AT_LABELS[view.startAt].toLowerCase()}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-slate-700 dark:text-slate-300">
          {isDesktopStart ? <PlanIcon name="monitor" aria-label="Start page on computers" /> : null}
          {isMobileStart ? <PlanIcon name="smartphone" aria-label="Start page on phones" /> : null}
          {isCurrent ? <PlanIcon name="check" aria-label="Current view" /> : null}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete view ${view.name}`}
        title="Delete view"
        className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-600 focus-visible:rounded-full hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
      >
        <PlanIcon name="x" />
      </button>
    </li>
  );
}
