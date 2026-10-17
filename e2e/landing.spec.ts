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

test('free play landing: LOI, DOI, powered descent with autopilot to touchdown', async ({ page }) => {
  test.setTimeout(400_000);
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-landing');
  await waitFrames(page, 5);
  let s = await state(page);
  expect(s.screen).toBe('landing');
  expect(s.body).toBe('moon');
  await cmd(page, 'fast', true);

  expect(((await cmd(page, 'plan', 'loi')) as Record<string, unknown>).error).toBeUndefined();
  await cmd(page, 'execute');
  s = await warpUntil(page, (st) => !st.autoBurn && !st.node);

  expect(((await cmd(page, 'plan', 'doi')) as Record<string, unknown>).error).toBeUndefined();
  await cmd(page, 'execute');
  s = await warpUntil(page, (st) => !st.autoBurn && !st.node);
  // Coast down toward the 15 km periapsis.
  s = await warpUntil(page, (st) => (st.altitude as number) < 22_000);
  expect(s.altitude as number).toBeLessThan(25_000);

  await cmd(page, 'pdi');
  await cmd(page, 'autopilot', true);
  await cmd(page, 'fastDescent', true);
  await waitFrames(page, 10);
  await page.screenshot({ path: 'e2e/screenshots/landing-pdi.png' });
  let shotLow = false;
  const deadline = Date.now() + 240_000;
  while (!(s.ended as boolean) && Date.now() < deadline) {
    s = await state(page);
    if (!shotLow && s.altitude !== undefined && (s.altitude as number) < 60) {
      shotLow = true;
      await cmd(page, 'warp', 1);
      await waitFrames(page, 4);
      await page.screenshot({ path: 'e2e/screenshots/landing-final.png' });
    }
    await cmd(page, 'warp', (s.altitude as number) < 80 ? 2 : s.maxWarp);
    await waitFrames(page, 3);
  }
  s = await state(page);
  expect(s.ended).toBe(true);
  expect(s.outcome).toBe('landed');
  expect(s.success).toBe(true);
  await expect(page.locator('#results-panel')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/landing-results.png' });
  expect(errors).toEqual([]);
});
