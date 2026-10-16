import { expect, test, type Page } from '@playwright/test';
import { boot, cmd, state, trackErrors, waitFrames } from './helpers';

/** Warp as fast as allowed until `done(state)` is true. */
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

test('free play Earth orbit: circularize, auto-plan TLI, execute, reach a lunar trajectory', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-orbit');
  await waitFrames(page, 5);
  let s = await state(page);
  expect(s.screen).toBe('orbit');
  await cmd(page, 'fast', true);

  await cmd(page, 'plan', 'circ-apo');
  s = await state(page);
  expect(s.node).not.toBeNull();
  await cmd(page, 'execute');
  s = await warpUntil(page, (st) => !st.autoBurn && !st.node);
  expect(s.node).toBeNull();

  const r = (await cmd(page, 'plan', 'tli')) as Record<string, unknown>;
  expect(r.error).toBeUndefined();
  await waitFrames(page, 5);
  await page.screenshot({ path: 'e2e/screenshots/orbit-tli-plan.png' });
  await cmd(page, 'execute');
  s = await warpUntil(page, (st) => st.ended as boolean, 200_000);
  expect(s.ended).toBe(true);
  expect(s.success).toBe(true);
  await expect(page.locator('#results-panel')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/orbit-results.png' });
  expect(errors).toEqual([]);
});
