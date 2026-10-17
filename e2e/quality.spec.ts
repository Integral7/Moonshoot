import { expect, test } from '@playwright/test';
import { boot, state, trackErrors, waitFrames } from './helpers';

// The heaviest scenes (pad with smoke and tower, lunar surface with terrain and
// boulders) must render without errors at every quality preset.
for (const quality of ['low', 'high'] as const) {
  test(`heavy scenes render at ${quality} quality`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackErrors(page);
    await boot(page, quality);
    await page.click('#btn-freeplay');
    await page.click('#fp-launch');
    await waitFrames(page, 8);
    expect((await state(page)).quality).toBe(quality);
    await page.screenshot({ path: `e2e/screenshots/quality-${quality}-launch.png` });
    await page.click('#btn-menu');
    await page.click('#pm-quit');
    await page.click('#btn-freeplay');
    await page.click('#fp-return');
    await waitFrames(page, 8);
    await page.screenshot({ path: `e2e/screenshots/quality-${quality}-surface.png` });
    expect(errors).toEqual([]);
  });
}
