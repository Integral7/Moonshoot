import { expect, test } from '@playwright/test';
import { boot, cmd, state, trackErrors, waitFrames } from './helpers';

test('free play launch: autopilot flies to orbit and the debrief carries the orbit', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-launch');
  await waitFrames(page, 5);
  let s = await state(page);
  expect(s.screen).toBe('launch');
  expect(s.launched).toBe(false);
  await page.screenshot({ path: 'e2e/screenshots/launch-pad.png' });
  await cmd(page, 'autopilot', true);
  await cmd(page, 'launch');
  // Watch liftoff at 1x briefly.
  await page.waitForFunction(() => (window.__moonshot!.state().launched as boolean) === true, undefined, { timeout: 60_000 });
  await waitFrames(page, 20);
  await page.screenshot({ path: 'e2e/screenshots/launch-liftoff.png' });
  await cmd(page, 'fast', true);
  const deadline = Date.now() + 180_000;
  let shotAscent = false;
  while (!(s.ended as boolean) && Date.now() < deadline) {
    await cmd(page, 'warp', 100);
    await waitFrames(page, 4);
    s = await state(page);
    if (!shotAscent && (s.altitude as number) > 30_000) {
      shotAscent = true;
      await cmd(page, 'warp', 1);
      await waitFrames(page, 3);
      await page.screenshot({ path: 'e2e/screenshots/launch-ascent.png' });
    }
  }
  expect(s.failed).toBeNull();
  expect(s.ended).toBe(true);
  expect(s.success).toBe(true);
  expect(s.periapsis as number).toBeGreaterThan(100_000);
  await expect(page.locator('#results-panel')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/launch-results.png' });
  expect(errors).toEqual([]);
});
