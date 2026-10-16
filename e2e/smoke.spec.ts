import { expect, test, type Page } from '@playwright/test';

// Collect console errors and page errors for the whole test.
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function state(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => window.__moonshot!.state());
}

async function waitFrames(page: Page, n: number): Promise<void> {
  const start = (await state(page)).frames as number;
  await page.waitForFunction((target) => (window.__moonshot!.state().frames as number) >= target, start + n, {
    timeout: 30_000,
  });
}

test('boots to main menu and renders frames without errors', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__moonshot);
  await waitFrames(page, 10);
  const s = await state(page);
  expect(s.screen).toBe('menu');
  expect(s.webgl).toBe(true);
  await expect(page.locator('.title')).toHaveText('MOONSHOT');
  await page.screenshot({ path: 'e2e/screenshots/menu.png' });
  expect(errors).toEqual([]);
});

test('quality setting switches and persists', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__moonshot);
  await page.click('#btn-settings');
  for (const q of ['low', 'high', 'medium'] as const) {
    await page.click(`#settings-panel [data-quality="${q}"]`);
    await waitFrames(page, 3);
    expect((await state(page)).quality).toBe(q);
  }
  await page.click(`#settings-panel [data-quality="high"]`);
  await page.reload();
  await page.waitForFunction(() => !!window.__moonshot);
  expect((await state(page)).quality).toBe('high');
  expect(errors).toEqual([]);
});
