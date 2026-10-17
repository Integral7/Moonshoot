import { expect, test } from '@playwright/test';
import { boot, cmd, state, trackErrors, waitFrames } from './helpers';

test('a finished phase saves a replay that plays back with a telemetry graph', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-cruise');
  await waitFrames(page, 5);
  await cmd(page, 'fast', true);
  let s = await state(page);
  const deadline = Date.now() + 150_000;
  while (!(s.ended as boolean) && Date.now() < deadline) {
    await cmd(page, 'warp', s.maxWarp);
    await waitFrames(page, 3);
    s = await state(page);
  }
  expect(s.ended).toBe(true);
  await expect(page.locator('#results-panel #telemetry-graph')).toBeVisible();
  await page.click('#result-replay');
  await waitFrames(page, 5);
  s = await state(page);
  expect(s.screen).toBe('replay');
  expect(s.samples as number).toBeGreaterThan(10);
  await cmd(page, 'seek', 0.6);
  await waitFrames(page, 5);
  await page.screenshot({ path: 'e2e/screenshots/replay.png' });
  // Hover the graph for the tooltip.
  const box = await page.locator('.replay-panel .graph-canvas').boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await waitFrames(page, 2);
  await expect(page.locator('.replay-panel .graph-tooltip')).toBeVisible();
  await page.click('#replay-back');
  expect((await state(page)).screen).toBe('replays');
  expect((await state(page)).count as number).toBeGreaterThan(0);
  await page.screenshot({ path: 'e2e/screenshots/replay-list.png' });
  expect(errors).toEqual([]);
});
