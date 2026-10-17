import { expect, test, type Page } from '@playwright/test';
import { boot, cmd, state, trackErrors, waitFrames } from './helpers';

async function warpUntil(page: Page, done: (s: Record<string, unknown>) => boolean, ms = 150_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  let s = await state(page);
  while (!done(s) && Date.now() < deadline) {
    await cmd(page, 'warp', s.maxWarp);
    await waitFrames(page, 3);
    s = await state(page);
  }
  return s;
}

test('free play return: liftoff, TEI, coast, entry, splashdown', async ({ page }) => {
  test.setTimeout(420_000);
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-return');
  await waitFrames(page, 5);
  let s = await state(page);
  expect(s.screen).toBe('return');
  expect(s.mode).toBe('surface');
  await page.screenshot({ path: 'e2e/screenshots/return-surface.png' });
  await cmd(page, 'autopilot', true);
  await cmd(page, 'fastAscent', true);
  await cmd(page, 'fast', true);
  await cmd(page, 'liftoff');
  s = await warpUntil(page, (st) => st.mode === 'orbit', 120_000);
  expect(s.mode).toBe('orbit');

  expect(((await cmd(page, 'plan', 'tei')) as Record<string, unknown>).error).toBeUndefined();
  await cmd(page, 'execute');
  s = await warpUntil(page, (st) => !st.autoBurn && !st.node);
  await waitFrames(page, 5);
  s = await state(page);
  expect(s.gamma as number).toBeLessThan(-0.09);
  s = await warpUntil(page, (st) => st.mode === 'entry', 150_000);
  expect(s.mode).toBe('entry');
  await cmd(page, 'autopilot', true);
  let shot = false;
  s = await warpUntil(page, (st) => {
    return (st.ended as boolean) || (!shot && (st.altitude as number) < 70_000);
  }, 120_000);
  if (!s.ended) {
    shot = true;
    await cmd(page, 'warp', 1);
    await waitFrames(page, 4);
    await page.screenshot({ path: 'e2e/screenshots/return-entry.png' });
  }
  s = await warpUntil(page, (st) => st.ended as boolean, 150_000);
  expect(s.ended).toBe(true);
  expect(s.success).toBe(true);
  await expect(page.locator('#results-panel')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/return-results.png' });
  expect(errors).toEqual([]);
});
