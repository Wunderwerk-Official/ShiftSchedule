import { render } from "@testing-library/react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Modal({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useModalFocus(true, ref);
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} />,
    document.body,
  );
}

describe("useModalFocus (re-QA)", () => {
  it("returns focus to the topmost open modal when the element that had it is gone", () => {
    const outer = render(<Modal label="Export" />);
    const exportDialog = document.querySelector('[aria-label="Export"]') as HTMLElement;
    expect(exportDialog).toHaveFocus();
    // Focus lost to the page (a button disabled in the same render) before the overlay opens.
    (document.activeElement as HTMLElement).blur();
    const overlay = render(<Modal label="Creating PDF" />);
    expect(exportDialog.closest("[inert]")).not.toBeNull();
    overlay.unmount();
    expect(exportDialog.closest("[inert]")).toBeNull();
    expect(exportDialog).toHaveFocus();
    outer.unmount();
    expect(document.querySelector("[inert]")).toBeNull();
  });
});
