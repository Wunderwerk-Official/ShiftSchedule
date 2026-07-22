import { useEffect, useRef, useState, type ReactNode } from "react";
import { getPillToggleClasses } from "../../lib/buttonStyles";
import { cx } from "../../lib/classNames";

type TopBarProps = {
  viewMode: "calendar" | "settings" | "help";
  onSetViewMode: (nextMode: "calendar" | "settings" | "help") => void;
  username: string;
  onLogout: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  // Snapshot control injected by the page — TopBar stays state-agnostic.
  snapshotSlot?: ReactNode;
};

export default function TopBar({
  viewMode,
  onSetViewMode,
  username,
  onLogout,
  theme,
  onToggleTheme,
  snapshotSlot,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current || menuRef.current.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);
  const badge = username
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <div className="relative border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onSetViewMode("calendar")}
            className="text-2xl font-semibold tracking-tight text-slate-900 transition-colors hover:text-slate-700 dark:text-slate-100 dark:hover:text-slate-200"
          >
            🩺 Shift Planner
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {snapshotSlot}
          <button
            type="button"
            onClick={() =>
              onSetViewMode(viewMode === "settings" ? "calendar" : "settings")
            }
            aria-pressed={viewMode === "settings"}
            className={getPillToggleClasses(viewMode === "settings")}
          >
            {viewMode === "settings" ? "Back" : "Settings"}
          </button>
          <button
            type="button"
            onClick={() => onSetViewMode(viewMode === "help" ? "calendar" : "help")}
            aria-pressed={viewMode === "help"}
            className={getPillToggleClasses(viewMode === "help")}
          >
            {viewMode === "help" ? "Back" : "Help"}
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="Toggle theme"
            className={cx(
              "inline-flex items-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm",
              "hover:bg-slate-50 active:bg-slate-100",
              "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
            )}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              aria-label="Account"
              onClick={() => setMenuOpen((open) => !open)}
              className={cx(
                "grid h-10 w-10 place-items-center rounded-full border border-slate-300 bg-transparent text-sm font-semibold text-slate-700 shadow-sm",
                "hover:bg-slate-100 active:bg-slate-200/80",
                "dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800/60",
              )}
            >
              {badge || "U"}
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-50 mt-2 w-40 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                <div className="px-2 py-1 text-xs font-semibold text-slate-500 dark:text-slate-300">
                  {username}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onLogout();
                    setMenuOpen(false);
                  }}
                  className={cx(
                    "mt-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs font-semibold",
                    "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                    "dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
                  )}
                >
                  <span>Sign out</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
