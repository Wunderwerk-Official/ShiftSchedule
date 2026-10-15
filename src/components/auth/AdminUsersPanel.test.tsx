import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialogProvider } from "../ui/ConfirmDialog";
import AdminUsersPanel from "./AdminUsersPanel";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  listUsers: vi.fn(() =>
    Promise.resolve([{ username: "dr-meyer", role: "user", active: true }]),
  ),
  adminListRunFeedback: vi.fn(() => Promise.resolve([])),
}));

const renderPanel = (isAdmin: boolean) => (
  <ConfirmDialogProvider>
    <AdminUsersPanel isAdmin={isAdmin} />
  </ConfirmDialogProvider>
);

describe("AdminUsersPanel", () => {
  it("survives isAdmin toggling on an existing instance (stable hook order)", async () => {
    const { container, rerender } = render(renderPanel(false));
    expect(container).toBeEmptyDOMElement();

    rerender(renderPanel(true));
    expect((await screen.findAllByText("dr-meyer")).length).toBeGreaterThan(0);

    rerender(renderPanel(false));
    expect(container).toBeEmptyDOMElement();
  });
});
