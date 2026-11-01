import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { SwapApiError, type Clinician } from "../../api/client";
import { cx } from "../../lib/classNames";
import { optionHighlightKeys, targetHighlightKeys } from "../../lib/swaps/format";
import type {
  SwapApplyRequest,
  SwapCandidatesRequest,
  SwapCandidatesResponse,
  SwapMode,
  SwapOpenTarget,
  SwapOption,
  SwapRecord,
} from "../../lib/swaps/types";
import { SwapSaveBlockedError } from "../../pages/swapFlow";
import PlanIcon from "../myPlan/PlanIcons";
import { TEXT_1, TEXT_3, segmentClass, segmentGroupClass } from "../myPlan/planChrome";
import { SwapGlyph } from "./PillSwapButton";
import SwapFinderPanel, { type SwapFilters } from "./SwapFinderPanel";
import SwapHighlightStyle from "./SwapHighlightStyle";
import SwapHistoryPanel from "./SwapHistoryPanel";
import SwapPreview from "./SwapPreview";

// The swap assistant (SPEC §5.4–5.5): a drawer at the right edge on desktop
// (no backdrop, the grid stays usable) and a full-height sheet on phones. It
// owns the search and the list; the page owns saving, applying and undoing.

export type SwapAssistantDrawerProps = {
  target: SwapOpenTarget;
  clinicians: Clinician[];
  isMobile: boolean;
  isDark: boolean;
  publishedWeekStartISOs: string[];
  /** Changes whenever the plan changes in a way that can change a verdict. */
  planToken: unknown;
  /** Changes after every apply and undo: the history loads again. */
  historyToken: number;
  onSearch: (request: SwapCandidatesRequest) => Promise<SwapCandidatesResponse>;
  onApply: (request: SwapApplyRequest) => Promise<void>;
  onUndo: (swapId: string) => Promise<void>;
  onLoadHistory: () => Promise<SwapRecord[]>;
  /** Scrolls a pill (assignment key) into view next to the drawer. */
  onRevealKey: (key: string) => void;
  onClose: () => void;
};

type Tab = "find" | "history";

const SEARCH_DEBOUNCE_MS = 200;
const REVEAL_DELAY_MS = 400;
const DEFAULT_FILTERS: SwapFilters = { partnerId: null, range: "fourWeeks", dates: [], sameTypeOnly: false };
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function drawerTitle(target: SwapOpenTarget): string {
  if (target.kind === "history") return "Swap history";
  return target.kind === "slot" ? "Find cover" : "Find a swap";
}

function searchRequest(
  target: SwapOpenTarget,
  mode: SwapMode,
  wholeDay: boolean,
  filters: SwapFilters,
): SwapCandidatesRequest {
  return {
    mode,
    assignment: target.kind === "assignment" ? target.assignment : null,
    slot: target.kind === "slot" ? target.slot : null,
    wholeDay,
    partnerId: filters.partnerId,
    range: filters.range,
    dates: filters.range === "dates" ? filters.dates : [],
    sameTypeOnly: filters.sameTypeOnly,
  };
}

function searchErrorMessage(err: unknown): string {
  if (err instanceof SwapSaveBlockedError) {
    return `${err.message} Use Retry saving or Reload saved calendar at the top of the page, then search again.`;
  }
  if (err instanceof SwapApiError && err.code === "state_changed") {
    return "The calendar changed while searching. Search again.";
  }
  return err instanceof Error ? err.message : "The search failed.";
}

/** A valid option (best or possible); blocked options have no preview. */
function previewableOption(response: SwapCandidatesResponse | null, key: string | null): SwapOption | null {
  if (!response || !key) return null;
  return [...response.best, ...response.possible].find((option) => option.key === key) ?? null;
}

function listedOption(response: SwapCandidatesResponse | null, key: string | null): SwapOption | null {
  if (!response || !key) return null;
  const lists = [response.best, response.possible, response.blocked, response.closest];
  return lists.flat().find((option) => option.key === key) ?? null;
}

function announcement(response: SwapCandidatesResponse): string {
  if (response.target.blocked) return response.target.blocked.message;
  const { best, possible, blocked } = response.totals;
  return `${best} best matches, ${possible} also possible, ${blocked} not possible. Checked ${response.checked} options.`;
}

export default function SwapAssistantDrawer(props: SwapAssistantDrawerProps) {
  const { target, clinicians, isMobile, isDark, planToken } = props;
  // Callbacks are read through this ref: no effect lists one, so a page
  // re-render never searches again (each search may save the calendar).
  const cb = useRef(props);
  cb.current = props;
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const historyOnly = target.kind === "history";
  const [tab, setTab] = useState<Tab>(historyOnly ? "history" : "find");
  const [mode, setMode] = useState<SwapMode>(target.kind === "slot" ? "cover" : "swap");
  const [wholeDay, setWholeDay] = useState(false);
  const [filters, setFilters] = useState<SwapFilters>(DEFAULT_FILTERS);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [response, setResponse] = useState<SwapCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [fetchedToken, setFetchedToken] = useState(planToken);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const listScrollTop = useRef(0);
  const backFocusKey = useRef<string | null>(null);

  const filtersKey = JSON.stringify(filters);
  const pickingDates = mode === "swap" && filters.range === "dates" && filters.dates.length === 0;

  useEffect(() => {
    if (historyOnly) return;
    // A newer search (or "pick a date first") drops every older answer.
    const seq = ++requestSeq.current;
    if (pickingDates) return;
    setLoading(true);
    const timer = window.setTimeout(() => {
      cb.current.onSearch(searchRequest(target, mode, wholeDay, filters)).then(
        (next) => {
          if (seq !== requestSeq.current) return;
          setResponse(next);
          setError(null);
          setLoading(false);
          // After a refresh the preview stays open while its option is still valid.
          setPreviewKey((key) => (previewableOption(next, key) ? key : null));
        },
        (err: unknown) => {
          if (seq !== requestSeq.current) return;
          setError(err);
          setLoading(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [mode, wholeDay, filtersKey, refreshNonce]);

  // The plan this list was made from: the token of the render that showed the
  // answer. A reload inside the search (hydrated before the answer) is no change.
  useLayoutEffect(() => {
    setFetchedToken(planToken);
  }, [response]);
  const stale = response !== null && fetchedToken !== planToken;

  const previewOption = tab === "find" ? previewableOption(response, previewKey) : null;
  const lookedAt = listedOption(response, previewKey ?? hoveredKey);
  const hoverKeys = lookedAt ? optionHighlightKeys(lookedAt) : [];
  const highlightKeys = response ? [...targetHighlightKeys(response.target), ...hoverKeys] : [];
  const revealKey = hoverKeys[0] ?? null;

  useEffect(() => {
    if (!revealKey) return;
    const timer = window.setTimeout(() => cb.current.onRevealKey(revealKey), REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [revealKey]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // The phone sheet is modal: the page must not scroll behind it.
  useEffect(() => {
    if (!isMobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isMobile]);

  // The preview replaces the list in the same scroll area: it starts at the
  // top, and "Back" returns to the list's scroll position and its row.
  const previewOpen = previewOption !== null;
  const previewWasOpen = useRef(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (previewOpen === previewWasOpen.current || !body) return;
    previewWasOpen.current = previewOpen;
    if (previewOpen) {
      body.scrollTop = 0;
      return;
    }
    body.scrollTop = listScrollTop.current;
    const key = backFocusKey.current;
    backFocusKey.current = null;
    const button = key
      ? body.querySelector<HTMLElement>(`[data-swap-option="${CSS.escape(key)}"] [data-swap-preview]`)
      : null;
    if (button) {
      button.focus({ preventScroll: true });
    } else if (!panelRef.current?.contains(document.activeElement)) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [previewOpen]);

  const refresh = () => {
    setNotice(null);
    setRefreshNonce((nonce) => nonce + 1);
  };
  const openPreview = (key: string) => {
    listScrollTop.current = bodyRef.current?.scrollTop ?? 0;
    setNotice(null);
    setPreviewKey(key);
  };
  const backToList = () => {
    backFocusKey.current = previewKey;
    setNotice(null);
    setPreviewKey(null);
  };
  const switchTab = (next: Tab) => {
    listScrollTop.current = 0;
    setHoveredKey(null);
    setPreviewKey(null);
    setNotice(null);
    setTab(next);
  };
  // A refused apply: the message stays (in the preview, or above the list when
  // the option is gone after the refresh).
  const onApplyError = (message: string, research: boolean) => {
    setNotice(message);
    if (research) setRefreshNonce((nonce) => nonce + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      cb.current.onClose();
      return;
    }
    if (event.key !== "Tab" || !isMobile) return;
    // The phone sheet is modal: Tab cycles inside it.
    const panel = panelRef.current;
    const items = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (element) => !element.closest("[hidden]"),
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === headingRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const liveText =
    tab === "find" && response && !loading && !pickingDates && !error ? announcement(response) : "";

  const content = (
    <>
      <div className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <SwapGlyph className="h-5 w-5 shrink-0 text-teal-700 dark:text-teal-300" />
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            // Focused on mount for screen readers; not a control, so no focus ring.
            className={cx(
              "min-w-0 flex-1 truncate text-base font-semibold focus:outline-none focus-visible:shadow-none",
              TEXT_1,
            )}
          >
            {drawerTitle(target)}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => cb.current.onClose()}
            className={cx(
              "grid shrink-0 place-items-center rounded-full hover:bg-slate-100 focus-visible:rounded-full dark:hover:bg-slate-800",
              isMobile ? "h-11 w-11" : "h-8 w-8",
              TEXT_3,
            )}
          >
            <PlanIcon name="x" size={isMobile ? 20 : 16} />
          </button>
        </div>
        {historyOnly ? null : (
          <div role="group" aria-label="Swap assistant view" className={cx(segmentGroupClass, "mt-3")}>
            {(["find", "history"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => switchTab(value)}
                className={cx(
                  segmentClass(tab === value),
                  "justify-center px-3.5",
                  isMobile ? "h-10 text-[15px]" : "h-8 text-[13px]",
                )}
              >
                {value === "find" ? "Find" : "History"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div ref={bodyRef} key={tab} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {tab === "history" ? (
          <SwapHistoryPanel
            load={() => cb.current.onLoadHistory()}
            onUndo={(swapId) => cb.current.onUndo(swapId)}
            refreshToken={props.historyToken}
            clinicians={clinicians}
            isDark={isDark}
          />
        ) : (
          <>
            <div hidden={previewOption !== null}>
              <SwapFinderPanel
                response={response}
                loading={loading}
                errorMessage={error ? searchErrorMessage(error) : null}
                notice={notice}
                stale={stale}
                isMobile={isMobile}
                isDark={isDark}
                mode={mode}
                wholeDay={wholeDay}
                filters={filters}
                clinicians={clinicians}
                onModeChange={(next) => {
                  setNotice(null);
                  setMode(next);
                }}
                onWholeDayChange={(next) => {
                  setNotice(null);
                  setWholeDay(next);
                }}
                onFiltersChange={(next) => {
                  setNotice(null);
                  setFilters(next);
                }}
                onRefresh={refresh}
                onPreview={openPreview}
                onHover={setHoveredKey}
              />
            </div>
            {previewOption && response ? (
              <SwapPreview
                key={previewOption.key}
                mode={response.target.mode}
                target={response.target}
                checks={response.checks}
                targetFindings={response.targetFindings}
                option={previewOption}
                clinicians={clinicians}
                isMobile={isMobile}
                isDark={isDark}
                publishedWeekStartISOs={props.publishedWeekStartISOs}
                notice={notice}
                stale={stale}
                onRefresh={refresh}
                onApply={(request) => cb.current.onApply(request)}
                onApplyError={onApplyError}
                onBack={backToList}
              />
            ) : null}
          </>
        )}
      </div>
      <div aria-live="polite" className="sr-only">
        {liveText}
      </div>
      <SwapHighlightStyle keys={highlightKeys} />
    </>
  );

  if (isMobile) {
    return createPortal(
      <div className="fixed inset-0 z-[80] flex flex-col justify-end">
        <div
          aria-hidden="true"
          onClick={() => cb.current.onClose()}
          className="absolute inset-0 bg-slate-900/30 dark:bg-black/50"
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          onKeyDown={onKeyDown}
          className="relative flex h-[calc(100dvh-12px)] flex-col rounded-t-2xl border-t border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          <span aria-hidden="true" className="mx-auto mt-2 block h-1 w-9 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
          {content}
        </div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className="fixed inset-y-0 right-0 z-[80] flex w-[440px] max-w-[100vw] flex-col border-l border-slate-200 bg-white text-slate-900 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      {content}
    </div>,
    document.body,
  );
}
