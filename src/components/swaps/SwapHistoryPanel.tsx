import { useEffect, useMemo, useRef, useState } from "react";
import type { Clinician } from "../../api/client";
import { cx } from "../../lib/classNames";
import { personTone } from "../../lib/myPlan";
import { recordItemLine, stampLabel, undoButtonLabel } from "../../lib/swaps/format";
import type { SwapMode, SwapRecord } from "../../lib/swaps/types";
import { TEXT_1, TEXT_2, TEXT_3, outlineButtonClass } from "../myPlan/planChrome";
import { Avatar } from "../myPlan/viewParts";
import { swapAlertClass } from "./SwapFinderPanel";

// History tab of the swap drawer (SPEC §5.5): the latest applied swaps, with
// Undo while the swapped shifts are unchanged. The only way to undo after the
// toast is gone.

/** The page asks for one page of this size (the server's default). */
const HISTORY_PAGE_SIZE = 50;

const KIND_LABELS: Record<SwapMode, string> = { swap: "Swap", handover: "Hand over", cover: "Cover" };
const chipClass = "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold";
const kindChipClass = cx(
  chipClass,
  "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200 dark:bg-teal-900/40 dark:text-teal-200 dark:ring-teal-700/60",
);
const undoneChipClass = cx(chipClass, "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200");

function recordTitle(record: SwapRecord): string {
  const requester = record.requesterName ?? "";
  if (record.kind === "swap") return `${requester} ⇄ ${record.partnerName}`;
  if (record.kind === "handover") return `${requester} → ${record.partnerName}`;
  return `${record.partnerName} covered ${record.give[0]?.sectionName ?? ""}`;
}

function appliedLine(record: SwapRecord): string {
  return [
    `Applied ${stampLabel(record.appliedAt)}`,
    record.approverName ? `approved by ${record.approverName}` : null,
    record.noticeOverride ? "inside notice period" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type SwapHistoryPanelProps = {
  load: () => Promise<SwapRecord[]>;
  onUndo: (id: string) => Promise<void>;
  /** Changes after every apply and undo: the list loads again. */
  refreshToken: number;
  clinicians: Clinician[];
  isDark: boolean;
};

export default function SwapHistoryPanel(props: SwapHistoryPanelProps) {
  // Latest callbacks: a page re-render must not load the history again.
  const latest = useRef(props);
  latest.current = props;
  const [records, setRecords] = useState<SwapRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});
  const toneIndex = useMemo(
    () => new Map(props.clinicians.map((clinician, index) => [clinician.id, index])),
    [props.clinicians],
  );

  useEffect(() => {
    let current = true;
    setFailed(false);
    latest.current.load().then(
      (next) => {
        if (current) setRecords(next);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [props.refreshToken, retryNonce]);

  const undo = async (id: string) => {
    // aria-disabled, not disabled, while one runs: the focused button keeps focus.
    if (undoingId !== null) return;
    setUndoingId(id);
    setUndoErrors((errors) => {
      const rest = { ...errors };
      delete rest[id];
      return rest;
    });
    try {
      await latest.current.onUndo(id);
    } catch (err) {
      setUndoErrors((errors) => ({ ...errors, [id]: err instanceof Error ? err.message : "Undo failed." }));
    } finally {
      setUndoingId(null);
    }
  };

  if (failed) {
    return (
      <div role="alert" className={cx(swapAlertClass, "mt-3 flex flex-col items-start gap-2")}>
        <span>History could not be loaded.</span>
        <button
          type="button"
          onClick={() => setRetryNonce((nonce) => nonce + 1)}
          className={cx(outlineButtonClass, "bg-white dark:bg-slate-900")}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!records) return <p className={cx("py-3 text-[13px]", TEXT_3)}>Loading history…</p>;
  if (records.length === 0) return <p className={cx("py-3 text-[13px]", TEXT_3)}>No swaps yet.</p>;
  return (
    <div className="flex flex-col pb-4">
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {records.map((record) => {
          const index = toneIndex.get(record.partnerId);
          const error = undoErrors[record.id];
          return (
            // Focus comes back to the row when its Undo is gone (undone, or no longer possible).
            <li key={record.id} tabIndex={-1} data-swap-focus-home="" className="flex flex-col gap-1 py-3">
              <div className="flex items-center gap-2">
                <Avatar
                  name={record.partnerName}
                  tone={index === undefined ? undefined : personTone(index, props.isDark)}
                />
                <span className={cx("min-w-0 flex-1 truncate text-[13px] font-semibold", TEXT_1)}>
                  {recordTitle(record)}
                </span>
                <span className={kindChipClass}>{KIND_LABELS[record.kind]}</span>
                {record.status === "reverted" ? <span className={undoneChipClass}>Undone</span> : null}
              </div>
              <ul className={cx("text-xs tabular-nums", TEXT_2)}>
                {[...record.give, ...record.take].map((item) => (
                  <li key={`${item.rowId}@${item.dateISO}`}>{recordItemLine(item)}</li>
                ))}
              </ul>
              <p className={cx("text-xs", TEXT_3)}>{appliedLine(record)}</p>
              {record.note ? <p className={cx("text-xs", TEXT_2)}>“{record.note}”</p> : null}
              {record.status === "reverted" && record.revertedAt ? (
                <p className={cx("text-xs", TEXT_3)}>Undone {stampLabel(record.revertedAt)}</p>
              ) : null}
              {record.canUndo ? (
                <button
                  type="button"
                  aria-label={undoButtonLabel(record, undoingId === record.id)}
                  aria-disabled={undoingId !== null || undefined}
                  onClick={() => void undo(record.id)}
                  className={cx(outlineButtonClass, "mt-1 self-start aria-disabled:cursor-not-allowed aria-disabled:opacity-60")}
                >
                  {undoingId === record.id ? "Undoing…" : "Undo"}
                </button>
              ) : record.undoBlockedReason ? (
                <p className={cx("text-xs", TEXT_3)}>{record.undoBlockedReason}</p>
              ) : null}
              {error ? (
                <p role="alert" className={cx(swapAlertClass, "mt-1")}>
                  {error}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {records.length >= HISTORY_PAGE_SIZE ? (
        <p className={cx("pt-2 text-xs", TEXT_3)}>Showing the latest {HISTORY_PAGE_SIZE}.</p>
      ) : null}
    </div>
  );
}
