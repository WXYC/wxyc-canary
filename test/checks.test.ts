import { describe, expect, it } from 'vitest';
import { checks, checksForSuite, VALID_SUITES } from '../src/checks.js';

describe('checksForSuite', () => {
  it('returns the BS+LML smoke set in the expected order', () => {
    // The order is the canary's docstring order: anonymous-first, then
    // DJ-authed surfaces. A staging-gate consumer doesn't depend on the
    // order, but a drift in the tag set is exactly what this test exists
    // to catch.
    expect(checksForSuite('smoke').map((c) => c.name)).toEqual([
      'backend-healthcheck',
      'proxy-library-search',
      'dj-library-search',
      'dj-flowsheet-read',
      'lml-auth',
    ]);
  });

  it('excludes Lambda-only checks from smoke', () => {
    const smokeNames = checksForSuite('smoke').map((c) => c.name);
    // Each of these is excluded for a different reason (see plan / README):
    // semantic-index-search is a different service; dj-rotation* duplicate
    // or flaky against staging; gha-runner-online is the runner the CLI
    // runs on; enrichment-quality writes + polls 45s.
    for (const name of [
      'semantic-index-search',
      'dj-rotation',
      'dj-rotation-picker',
      'gha-runner-online',
      'enrichment-quality',
    ]) {
      expect(smokeNames).not.toContain(name);
    }
  });

  it('every smoke-tagged check still appears in the full checks array', () => {
    // Catches a refactor that adds a Check with `suites: ['smoke']` but
    // forgets to wire it into `checks` — the CLI would silently drop it
    // and the gate would lose a probe.
    const fullNames = new Set(checks.map((c) => c.name));
    for (const c of checksForSuite('smoke')) {
      expect(fullNames).toContain(c.name);
    }
  });
});

describe('VALID_SUITES', () => {
  it('contains exactly the suite tags supported at v1', () => {
    // Locked: the CLI's --suite validator reads this constant. Adding a
    // suite is intentional surface work — extend Suite, add here, tag
    // checks, then update this assertion.
    expect([...VALID_SUITES]).toEqual(['smoke']);
  });
});
