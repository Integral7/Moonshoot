import { expect, test, type Page } from '@playwright/test';
import { boot, cmd, planAndBurn, state, trackErrors, waitFrames, warpUntil } from './helpers';

async function continueTo(page: Page, screen: string): Promise<void> {
  await expect(page.locator('#result-continue')).toBeEnabled();
  await page.click('#result-continue');
  await page.waitForFunction((s) => window.__moonshot!.state().screen === s, screen, { timeout: 60_000 });
  await waitFrames(page, 5);
}

async function expectPhaseSuccess(page: Page, label: string): Promise<void> {
  const s = await state(page);
  expect(s.ended, `${label} ended`).toBe(true);
  expect(s.success, `${label} success (${JSON.stringify({ failed: s.failed, outcome: s.outcome })})`).toBe(true);
}

test('full campaign: design to splashdown on autopilots and planners, then the mission summary', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const errors = trackErrors(page);
  await boot(page, 'low');

  // 1. Vehicle design (recommended template).
  await page.click('#btn-campaign');
  await waitFrames(page, 5);
  expect((await state(page)).feasible).toBe(true);
  await page.click('#btn-approve');
  await continueTo(page, 'launch');

  // 2. Launch.
  await cmd(page, 'autopilot', true);
  await cmd(page, 'launch');
  await cmd(page, 'fast', true);
  await warpUntil(page, (s) => s.ended as boolean, 240_000, 100);
  await expectPhaseSuccess(page, 'launch');
  await continueTo(page, 'orbit');

  // 3. Earth orbit: circularize, TLI.
  await cmd(page, 'fast', true);
  await planAndBurn(page, 'circ-apo');
  await planAndBurn(page, 'tli');
  await warpUntil(page, (s) => s.ended as boolean, 200_000);
  await expectPhaseSuccess(page, 'orbit');
  await continueTo(page, 'cruise');

  // 4. Cruise: mid-course correction.
  await cmd(page, 'fast', true);
  await planAndBurn(page, 'mcc');
  await warpUntil(page, (s) => s.ended as boolean, 200_000);
  await expectPhaseSuccess(page, 'cruise');
  await continueTo(page, 'landing');

  // 5. Lunar orbit and landing.
  await cmd(page, 'fast', true);
  await planAndBurn(page, 'loi');
  await planAndBurn(page, 'doi');
  await warpUntil(page, (s) => (s.altitude as number) < 22_000, 200_000);
  await cmd(page, 'pdi');
  await cmd(page, 'autopilot', true);
  await cmd(page, 'fastDescent', true);
  await warpUntil(page, (s) => s.ended as boolean, 300_000, 50);
  await expectPhaseSuccess(page, 'landing');
  await continueTo(page, 'return');

  // 6. Return.
  await cmd(page, 'autopilot', true);
  await cmd(page, 'fastAscent', true);
  await cmd(page, 'fast', true);
  await cmd(page, 'liftoff');
  await warpUntil(page, (s) => s.mode === 'orbit', 200_000);
  await planAndBurn(page, 'tei');
  await warpUntil(page, (s) => s.mode === 'entry', 200_000);
  await cmd(page, 'autopilot', true);
  await warpUntil(page, (s) => s.ended as boolean, 200_000);
  await expectPhaseSuccess(page, 'return');

  // Mission summary.
  await page.click('#result-summary');
  await expect(page.locator('#mission-summary')).toBeVisible();
  const s = await state(page);
  expect(s.phases).toBe(6);
  expect(s.total as number).toBeGreaterThan(3_000);
  await page.screenshot({ path: 'e2e/screenshots/mission-summary.png' });
  expect(errors).toEqual([]);
});

test('campaign progress is saved and can be resumed from the main menu', async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, 'low');
  await page.click('#btn-campaign');
  await waitFrames(page, 3);
  await page.click('#btn-approve');
  await continueTo(page, 'launch');
  await page.reload();
  await page.waitForFunction(() => !!window.__moonshot);
  await expect(page.locator('#btn-continue')).toContainText('Launch');
  await page.click('#btn-continue');
  await page.waitForFunction(() => window.__moonshot!.state().screen === 'launch');
  expect(errors).toEqual([]);
});
