import type { Page } from '@playwright/test';

export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

export async function state(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => window.__moonshot!.state());
}

export async function cmd(page: Page, c: string, arg?: unknown): Promise<unknown> {
  return page.evaluate(([cc, a]) => window.__moonshot!.cmd(cc as string, a), [c, arg] as const);
}

export async function waitFrames(page: Page, n: number): Promise<void> {
  const start = (await state(page)).frames as number;
  await page.waitForFunction((target) => (window.__moonshot!.state().frames as number) >= target, start + n, {
    timeout: 60_000,
  });
}

/** Load the app with a given quality preset already saved. */
export async function boot(page: Page, quality: 'low' | 'medium' | 'high' = 'low'): Promise<void> {
  await page.addInitScript((q) => {
    try {
      localStorage.setItem('moonshot.settings.v1', JSON.stringify({ quality: q, callouts: false }));
    } catch {
      /* ignore */
    }
  }, quality);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__moonshot);
}

/** Time-warp as fast as the screen allows until `done(state)` is true. */
export async function warpUntil(page: Page, done: (s: Record<string, unknown>) => boolean, ms = 150_000, warp?: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  let s = await state(page);
  while (!done(s) && Date.now() < deadline) {
    await cmd(page, 'warp', warp ?? (s.maxWarp as number) ?? 1);
    await waitFrames(page, 3);
    s = await state(page);
  }
  return s;
}

/** Plan with a named planner and execute it, then warp until the burn is done. */
export async function planAndBurn(page: Page, planner: string): Promise<Record<string, unknown>> {
  const r = (await cmd(page, 'plan', planner)) as Record<string, unknown>;
  if (r.error) throw new Error(`planner ${planner}: ${String(r.error)}`);
  await cmd(page, 'execute');
  return warpUntil(page, (st) => !st.autoBurn && !st.node);
}
