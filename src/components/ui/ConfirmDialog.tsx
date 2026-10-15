import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "default";
};

type ConfirmContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm must be used within a ConfirmDialogProvider");
  }
  return context.confirm;
}

type DialogState = {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
} | null;

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setDialog({ options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (dialog) {
      dialog.resolve(true);
      setDialog(null);
    }
  }, [dialog]);

  const handleCancel = useCallback(() => {
    if (dialog) {
      dialog.resolve(false);
      setDialog(null);
    }
  }, [dialog]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleCancel();
    }
  }, [handleCancel]);

  // Enter is left to the focused button (Confirm has autoFocus), so Enter on a
  // focused "Cancel" cancels instead of confirming a destructive action.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleCancel();
    }
  }, [handleCancel]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {dialog &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
            onClick={handleBackdropClick}
            onKeyDown={handleKeyDown}
          >
            <div
              className={cx(
                "w-full max-w-md rounded-2xl bg-white p-6 shadow-xl",
                "dark:bg-slate-900 dark:ring-1 dark:ring-slate-700",
                "animate-in fade-in zoom-in-95 duration-150",
              )}
            >
              {dialog.options.title && (
                <h2
                  id="confirm-dialog-title"
                  className="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100"
                >
                  {dialog.options.title}
                </h2>
              )}
              <p
                id="confirm-dialog-message"
                className="text-sm text-slate-600 dark:text-slate-300"
              >
                {dialog.options.message}
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleCancel}
                  className={cx(
                    "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700",
                    "hover:bg-slate-50 active:bg-slate-100",
                    "dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
                    "focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 dark:focus:ring-offset-slate-900",
                  )}
                >
                  {dialog.options.cancelLabel ?? "Cancel"}
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  autoFocus
                  className={cx(
                    "rounded-xl px-4 py-2 text-sm font-semibold text-white",
                    "focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-900",
                    dialog.options.variant === "danger"
                      ? "bg-rose-600 hover:bg-rose-700 active:bg-rose-800 focus:ring-rose-500"
                      : dialog.options.variant === "warning"
                        ? "bg-amber-600 hover:bg-amber-700 active:bg-amber-800 focus:ring-amber-500"
                        : "bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 focus:ring-indigo-500",
                  )}
                >
                  {dialog.options.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}
