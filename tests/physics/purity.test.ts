import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The physics module must stay pure: no rendering, DOM, or app imports.
describe('physics module purity', () => {
  const dir = join(__dirname, '../../src/physics');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    it(`${file} only imports from src/physics`, () => {
      const src = readFileSync(join(dir, file), 'utf8');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec.startsWith('./')).toBe(true);
      expect(src).not.toMatch(/\b(window|document|localStorage)\.\w/);
    });
  }
});
