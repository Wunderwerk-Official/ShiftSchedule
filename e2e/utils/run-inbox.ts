import { expect, type Page } from "@playwright/test";

export const RUN_FINISHED_NOTICE =
  "Run finished - review the result in the run inbox and apply it.";
const RUN_INBOX_HINT = "Results wait here until you apply or discard them.";

/**
 * Apply the run that was just started with "Run".
 *
 * Since v1.53 a finished solver run waits in the run inbox (the "About
 * Automated Planning" dialog opens with one card per run, newest first);
 * nothing reaches the calendar until the run is applied. Applying can ask
 * for confirmation: always for a partial draft (the basic plan used without
 * an AI key never verifies completion) and, if the calendar changed while
 * the run was going, to apply anyway. Both are accepted here. The inbox is
 * closed afterwards so the calendar is usable again.
 *
 * Returns the confirm messages that were accepted.
 */
export async function applyNewestRun(
  page: Page,
  { timeout = 30_000 }: { timeout?: number } = {},
): Promise<string[]> {
  await expect(page.getByText(RUN_FINISHED_NOTICE)).toBeVisible({ timeout });
  const inbox = page.getByRole("dialog").filter({ hasText: RUN_INBOX_HINT });
  await expect(inbox).toBeVisible();

  const newest = inbox.locator('[data-testid^="run-card-"]').first();
  await expect(newest).toContainText("Ready to apply");
  // Pin the card by its run id: the list re-sorts and re-renders on refresh.
  const cardTestId = await newest.getAttribute("data-testid");
  expect(cardTestId).toBeTruthy();
  const card = inbox.getByTestId(cardTestId!);

  const confirms: string[] = [];
  page.on("dialog", (dialog) => {
    confirms.push(dialog.message());
    void dialog.accept();
  });
  await card.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(card).toContainText("Applied", { timeout });

  await inbox.getByRole("button", { name: "Close" }).click();
  await expect(inbox).toBeHidden();
  return confirms;
}
