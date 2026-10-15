import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConfirmDialogProvider, useConfirm } from "./ConfirmDialog";

function Opener({ results }: { results: boolean[] }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={async () => {
        results.push(await confirm({ message: "Delete user?", variant: "danger" }));
      }}
    >
      Open
    </button>
  );
}

const setup = () => {
  const results: boolean[] = [];
  render(
    <ConfirmDialogProvider>
      <Opener results={results} />
    </ConfirmDialogProvider>,
  );
  return { results, user: userEvent.setup() };
};

describe("ConfirmDialog keyboard handling", () => {
  it("confirms on Enter when the autofocused Confirm button has focus", async () => {
    const { results, user } = setup();
    await user.click(screen.getByText("Open"));
    expect(screen.getByText("Confirm")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(results).toEqual([true]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels on Enter when Cancel has focus", async () => {
    const { results, user } = setup();
    await user.click(screen.getByText("Open"));
    await user.tab({ shift: true });
    expect(screen.getByText("Cancel")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("cancels on Escape", async () => {
    const { results, user } = setup();
    await user.click(screen.getByText("Open"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(results).toEqual([false]));
  });
});
