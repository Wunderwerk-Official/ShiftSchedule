import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { AppState } from '../src/api/client';

async function calendar(page: Page, sheet = false, repeatedId = false, source: 'solver' | 'manual' = 'solver') {
  let state = JSON.parse(readFileSync(new URL('../backend/default_state.json', import.meta.url), 'utf8')) as AppState;
  state.revision = 'r0';
  state.solverSettings = { ...state.solverSettings, scheduleLayout: sheet ? 'clinicSheet' : 'classic' };
  const slot = state.weeklyTemplate!.locations[0].slots[0];
  state.assignments = [{ id: 'fixed-test', rowId: slot.id, dateISO: '2026-01-05', clinicianId: state.clinicians[0].id, source }];
  if (repeatedId) state.assignments.push({ ...state.assignments[0], dateISO: '2026-01-12' });
  let revision = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.clock.setFixedTime(new Date('2026-01-05T12:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('authToken', 'test-token'));
  await page.route('**/auth/me', route => route.fulfill({ json: { username: 'test', role: 'user', active: true } }));
  await page.route('**/v1/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/v1/state')) {
      if (req.method() === 'POST') state = { ...req.postDataJSON(), revision: `r${++revision}` };
      return route.fulfill({ json: state });
    }
    if (path.endsWith('/solve/runs')) return route.fulfill({ json: { runs: [] } });
    if (path.endsWith('/agent/settings')) return route.fulfill({ json: { effective_model: 'mock', budget_usd: 5, remaining_usd: 5 } });
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Lock assignment for/ }).first()).toBeAttached();
  return { state: () => state, errors };
}

const lock = (page: Page) => page.getByRole('button', { name: /^Lock assignment for/ }).first();
// The two Reset choices; both keep locked shifts.
const RESETS = [
  { label: 'Unlocked shifts', name: /^Unlocked shifts Removes/ },
  { label: 'Unlocked shifts and rest days', name: /^Unlocked shifts and rest days/ },
];
async function reset(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name }).click();
}

for (const choice of RESETS) {
  test(`locked planner assignment survives Reset → ${choice.label} and can be unlocked`, async ({ page }, testInfo) => {
    const api = await calendar(page);
    await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
    await lock(page).click();
    await expect.poll(() => api.state().assignments[0]?.locked).toBe(true);
    await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath('locked-calendar.png'), animations: 'disabled' });
    await reset(page, choice.name);
    await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
    await lock(page).click();
    await expect.poll(() => api.state().assignments[0]?.locked).toBe(false);
    await reset(page, choice.name);
    await expect.poll(() => api.state().assignments.length).toBe(0);
    expect(api.errors).toEqual([]);
  });
}

test('a hand-placed assignment starts locked; unlocking hands it to the planner and Reset removes it', async ({ page }) => {
  const api = await calendar(page, false, false, 'manual');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await reset(page, RESETS[1].name);
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  expect(api.state().assignments).toHaveLength(1);
  await lock(page).click();
  await expect.poll(() => api.state().assignments[0]).toMatchObject({ source: 'solver', locked: false });
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
  await reset(page, RESETS[0].name);
  await expect.poll(() => api.state().assignments.length).toBe(0);
  expect(api.errors).toEqual([]);
});

test('monthly sheet can lock an assignment with the keyboard and retain it after reload', async ({ page }, testInfo) => {
  const api = await calendar(page, true);
  await expect.poll(() => api.state().revision).not.toBe('r0');
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'false');
  await lock(page).press('Enter');
  await expect.poll(() => api.state().assignments[0]?.locked).toBe(true);
  await page.reload();
  await expect(lock(page)).toHaveAttribute('aria-pressed', 'true');
  await lock(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('locked-month.png'), animations: 'disabled' });
  expect(api.errors).toEqual([]);
});


test('locking an imported entry does not affect another date with the same imported id', async ({ page }) => {
  const api = await calendar(page, false, true);
  await lock(page).click();
  await expect.poll(() => api.state().assignments.find(a => a.dateISO === '2026-01-05')?.locked).toBe(true);
  expect(api.state().assignments.find(a => a.dateISO === '2026-01-12')?.locked).not.toBe(true);
});
