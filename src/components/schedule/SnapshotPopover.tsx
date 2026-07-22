import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteSnapshot,
  listSnapshots,
  renameSnapshot,
  type SnapshotMeta,
} from "../../api/client";
import { cx } from "../../lib/classNames";

// Named calendar snapshots ("quicksave"): save the current calendar under a
// name, restore/rename/delete versions. Lives in the TopBar so it is
// reachable from every layout; the panel portals to document.body like
// PublishWeeksPopover (the app shell clips overflow).
type SnapshotPopoverProps = {
  // Parent owns the payload (buildCurrentStatePayload) and the API call.
  onSaveSnapshot: (name: string) => Promise<void>;
  // Parent owns the full restore dance (timer gate + hydrate).
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
  // Restoring mid-solve would be clobbered by the run's completion write.
  restoreDisabled?: boolean;
};

const formatDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export default function SnapshotPopover({
  onSaveSnapshot,
  onRestoreSnapshot,
  restoreDisabled = false,
}: SnapshotPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<{
    id: string;
    action: "restore" | "delete";
  } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(
    null,
  );

  const refresh = async () => {
    try {
      setSnapshots(await listSnapshots());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snapshots.");
    }
  };

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - 336) });
    }
    setConfirm(null);
    setRenaming(null);
    void refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleSave = async () => {
    const name = saveName.trim();
    if (!name || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSaveSnapshot(name);
      setSaveName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save snapshot.");
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (snapshotId: string) => {
    setBusyId(snapshotId);
    setError(null);
    try {
      await onRestoreSnapshot(snapshotId);
      setConfirm(null);
      await refresh(); // the auto-backup row appeared/changed
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore snapshot.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (snapshotId: string) => {
    setBusyId(snapshotId);
    setError(null);
    try {
      await deleteSnapshot(snapshotId);
      setConfirm(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete snapshot.");
    } finally {
      setBusyId(null);
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name) {
      setRenaming(null);
      return;
    }
    setBusyId(renaming.id);
    setError(null);
    try {
      await renameSnapshot(renaming.id, name);
      setRenaming(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename snapshot.");
    } finally {
      setBusyId(null);
    }
  };

  const actionButtonClass =
    "rounded-full px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Calendar snapshots"
        title="Calendar snapshots"
        onClick={() => setOpen((prev) => !prev)}
        className={cx(
          "inline-flex items-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm",
          "hover:bg-slate-50 active:bg-slate-100",
          "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
          open && "bg-slate-100 dark:bg-slate-700",
        )}
      >
        {/* Floppy-disk icon */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-[1000] w-[21rem] rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-800"
              style={{ top: position.top, left: position.left }}
            >
              <div className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                Calendar snapshots
              </div>
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="text"
                  value={saveName}
                  maxLength={100}
                  placeholder="Snapshot name"
                  onChange={(event) => setSaveName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSave();
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={!saveName.trim() || saving}
                  className="shrink-0 rounded-full bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              {error ? (
                <div className="mb-2 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                  {error}
                </div>
              ) : null}
              <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {snapshots === null ? (
                  <div className="px-2 py-3 text-center text-xs text-slate-500 dark:text-slate-400">
                    Loading…
                  </div>
                ) : snapshots.length === 0 ? (
                  <div className="px-2 py-3 text-center text-xs text-slate-500 dark:text-slate-400">
                    No snapshots yet. Save the current calendar above.
                  </div>
                ) : (
                  snapshots.map((snapshot) => {
                    const busy = busyId !== null;
                    const isConfirming = confirm?.id === snapshot.id;
                    const isRenaming = renaming?.id === snapshot.id;
                    return (
                      <div
                        key={snapshot.id}
                        className="rounded-lg border border-slate-100 px-2 py-1.5 dark:border-slate-700/60"
                      >
                        {isRenaming ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              autoFocus
                              value={renaming.value}
                              maxLength={100}
                              onChange={(event) =>
                                setRenaming({ id: snapshot.id, value: event.target.value })
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void handleRename();
                                if (event.key === "Escape") setRenaming(null);
                              }}
                              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRename()}
                              className={actionButtonClass}
                            >
                              OK
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                                  {snapshot.name}
                                  {snapshot.kind === "auto_backup" ? (
                                    <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                                      Automatic
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-[10px] text-slate-400 dark:text-slate-500">
                                  {formatDate(snapshot.created_at)}
                                </div>
                              </div>
                              {!isConfirming ? (
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={busy || restoreDisabled}
                                    title={
                                      restoreDisabled
                                        ? "Not available while the solver is running"
                                        : undefined
                                    }
                                    onClick={() =>
                                      setConfirm({ id: snapshot.id, action: "restore" })
                                    }
                                    className={actionButtonClass}
                                  >
                                    Restore
                                  </button>
                                  {snapshot.kind === "named" ? (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() =>
                                        setRenaming({ id: snapshot.id, value: snapshot.name })
                                      }
                                      className={actionButtonClass}
                                    >
                                      Rename
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      setConfirm({ id: snapshot.id, action: "delete" })
                                    }
                                    className={cx(
                                      actionButtonClass,
                                      "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40",
                                    )}
                                  >
                                    Delete
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            {isConfirming ? (
                              <div className="mt-1.5 rounded-lg bg-slate-50 px-2 py-1.5 dark:bg-slate-900/50">
                                <div className="text-[11px] text-slate-600 dark:text-slate-300">
                                  {confirm.action === "restore"
                                    ? "Restores the entire calendar (assignments, template, clinicians, settings). Your current calendar is saved to 'Auto-backup before restore' first."
                                    : "Delete this snapshot? This cannot be undone."}
                                </div>
                                <div className="mt-1.5 flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      confirm.action === "restore"
                                        ? void handleRestore(snapshot.id)
                                        : void handleDelete(snapshot.id)
                                    }
                                    className={cx(
                                      "rounded-full px-2.5 py-1 text-[11px] font-semibold disabled:opacity-40",
                                      confirm.action === "restore"
                                        ? "bg-emerald-600 text-white hover:bg-emerald-500"
                                        : "bg-rose-600 text-white hover:bg-rose-500",
                                    )}
                                  >
                                    {busyId === snapshot.id
                                      ? "Working…"
                                      : confirm.action === "restore"
                                        ? "Restore"
                                        : "Delete"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setConfirm(null)}
                                    className={actionButtonClass}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
