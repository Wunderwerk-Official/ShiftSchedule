import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/classNames";
import { useModalFocus } from "../../lib/useModalFocus";

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
  id: number;
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
} | null;

let nextDialogId = 0;

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      nextDialogId += 1;
      setDialog({ id: nextDialogId, options, resolve });
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

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {dialog && (
        <ConfirmDialogView
          key={dialog.id}
          options={dialog.options}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * The confirmation itself: a nested modal (useModalFocus), so a dialog
 * underneath (e.g. Export) is inert while it is open and gets its focus back
 * afterwards. Focus starts on the confirm button; Enter is left to the
 * focused button, so Enter on a focused "Cancel" cancels.
 */
function ConfirmDialogView({
  options,
  onConfirm,
  onCancel,
}: {
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, containerRef, confirmRef);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      ref={containerRef}
      onKeyDown={(e) => {
        // Escape cancels this dialog only, not a dialog underneath.
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        className={cx(
          "w-full max-w-md rounded-2xl bg-white p-6 shadow-xl",
          "dark:bg-slate-900 dark:ring-1 dark:ring-slate-700",
          "animate-in fade-in zoom-in-95 duration-150",
        )}
      >
        {options.title && (
          <h2
            id="confirm-dialog-title"
            className="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            {options.title}
          </h2>
        )}
        <p
          id="confirm-dialog-message"
          className="text-sm text-slate-600 dark:text-slate-300"
        >
          {options.message}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className={cx(
              "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700",
              "hover:bg-slate-50 active:bg-slate-100",
              "dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
              "focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 dark:focus:ring-offset-slate-900",
            )}
          >
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            className={cx(
              "rounded-xl px-4 py-2 text-sm font-semibold text-white",
              "focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-900",
              options.variant === "danger"
                ? "bg-rose-600 hover:bg-rose-700 active:bg-rose-800 focus:ring-rose-500"
                : options.variant === "warning"
                  ? "bg-amber-600 hover:bg-amber-700 active:bg-amber-800 focus:ring-amber-500"
                  : "bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 focus:ring-indigo-500",
            )}
          >
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
