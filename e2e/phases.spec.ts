import { expect, test } from '@playwright/test';
import { boot, cmd, state, trackErrors, waitFrames } from './helpers';

test('free play: cruise phase coasts to the Moon under time warp and shows a debrief', async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-freeplay');
  await page.click('#fp-cruise');
  await waitFrames(page, 5);
  let s = await state(page);
  expect(s.screen).toBe('cruise');
  expect(s.phase).toBe('cruise');
  await page.screenshot({ path: 'e2e/screenshots/cruise-start.png' });

  // Warp as fast as allowed until the phase ends (warp auto-limits near events).
  const deadline = Date.now() + 90_000;
  while (!(s.ended as boolean) && Date.now() < deadline) {
    await cmd(page, 'warp', s.maxWarp);
    await waitFrames(page, 3);
    s = await state(page);
  }
  expect(s.ended).toBe(true);
  expect(s.body).toBe('moon');
  await expect(page.locator('#results-panel')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/cruise-results.png' });
  expect(errors).toEqual([]);
});

test('free play menu lists all phases', async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await page.click('#btn-freeplay');
  for (const id of ['design', 'launch', 'orbit', 'cruise', 'landing', 'return']) {
    await expect(page.locator(`#fp-${id}`)).toBeVisible();
  }
  await page.click('#fp-back');
  expect((await state(page)).screen).toBe('menu');
  expect(errors).toEqual([]);
});

test('renders procedural Earth and Moon at medium quality', async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, 'medium');
  await page.click('#btn-freeplay');
  await page.click('#fp-cruise');
  await waitFrames(page, 3);
  await cmd(page, 'focus', 'earth');
  await cmd(page, 'view', { distance: 2.2e7, yaw: 1.2, pitch: 0.25 });
  await waitFrames(page, 4);
  await page.screenshot({ path: 'e2e/screenshots/earth-medium.png' });
  await cmd(page, 'focus', 'moon');
  await cmd(page, 'view', { distance: 6.5e6, yaw: -1.6, pitch: 0.2 });
  await waitFrames(page, 4);
  await page.screenshot({ path: 'e2e/screenshots/moon-medium.png' });
  expect(errors).toEqual([]);
});
