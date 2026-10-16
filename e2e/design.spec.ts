import { expect, test } from '@playwright/test';
import { boot, cmd, state, trackErrors, waitFrames } from './helpers';

test('campaign starts in vehicle design; template is feasible; approve shows debrief', async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, 'medium');
  await page.click('#btn-campaign');
  await waitFrames(page, 5);
  let s = await state(page);
  expect(s.screen).toBe('design');
  expect(s.feasible).toBe(true);
  expect(s.errors).toBe(0);
  await expect(page.locator('#budget-table')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/design.png' });
  await page.click('#btn-approve');
  await expect(page.locator('#results-panel')).toBeVisible();
  await expect(page.locator('#result-continue')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/design-results.png' });
  s = await state(page);
  expect(s.ended).toBe(true);
  expect(errors).toEqual([]);
});

test('editing the stack updates the budget and validation', async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-design');
  await waitFrames(page, 3);
  await cmd(page, 'template', 2); // Empty
  let s = await state(page);
  expect(s.parts).toBe(0);
  await expect(page.locator('#btn-approve')).toBeDisabled();
  // Build a capsule stage only: capsule but no chutes/shield -> errors.
  await page.click('[data-part="capsule-3"].part-card');
  s = await state(page);
  expect(s.parts).toBe(1);
  expect(s.errors as number).toBeGreaterThan(0);
  await expect(page.locator('#design-issues')).toContainText('heat shield');
  // Load the recommended template again and verify +/- on a run changes the part count.
  await cmd(page, 'template', 0);
  const before = (await state(page)).parts as number;
  await page.locator('.stack-row[data-part="eng-f1"] .icon-btn[title="Add another"]').click();
  expect((await state(page)).parts).toBe(before + 1);
  await page.locator('.stack-row[data-part="eng-f1"] .icon-btn[title="Remove one"]').click();
  expect((await state(page)).parts).toBe(before);
  await waitFrames(page, 3);
  expect(errors).toEqual([]);
});
