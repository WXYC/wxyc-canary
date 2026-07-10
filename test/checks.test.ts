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
      'oidc-authorize',
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
      'semantic-index-freshness',
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

/**
 * Classification pin for the paging tier (`pagesOncall`). This is the
 * load-bearing guard the noise-split (wxyc-canary#48) rests on: the
 * `wxyc-canary-check-failure` page reads the `UserFacingCheckFailure`
 * aggregate, which only collects checks whose `pagesOncall !== false`.
 *
 * `pagesOncall` defaults to true (fail-safe — a new check pages until
 * someone explicitly opts it out), and is DELIBERATELY independent of the
 * `suites` tag: `dj-rotation` / `dj-rotation-picker` are untagged
 * (CLI-unreachable) yet user-facing, so they must keep the paging default.
 * Deriving the tier from `suites` would silently demote both — the exact
 * regression this test exists to catch.
 */
describe('pagesOncall — paging-tier classification', () => {
  it('only the two infra probes opt out of paging', () => {
    // The infra/CI probes that flap on non-user-facing causes: the runner
    // being offline, and the silent-stale graph DB backstop. Everything else
    // pages. A new entry here is an intentional coverage reduction — it should
    // arrive with a tracked follow-up, never silently. `semantic-index-search`
    // was demoted for the nightly-blip window but is back on the page now that
    // semantic-index#347 ended the in-process OOM-restart (wxyc-canary#50);
    // `semantic-index-freshness` stays infra-tier (staleness is degradation,
    // not an outage).
    const nonPaging = checks
      .filter((c) => c.pagesOncall === false)
      .map((c) => c.name)
      .sort();
    expect(nonPaging).toEqual(['gha-runner-online', 'semantic-index-freshness']);
  });

  it('every other check pages by default (pagesOncall !== false)', () => {
    // Explicitly assert the two untagged-but-user-facing checks keep the
    // paging default — they are the ones a `suites`-derived tier would drop.
    const paging = new Set(checks.filter((c) => c.pagesOncall !== false).map((c) => c.name));
    expect(paging).toContain('dj-rotation');
    expect(paging).toContain('dj-rotation-picker');
    // semantic-index-search pages again post-#347 (wxyc-canary#50).
    expect(paging).toContain('semantic-index-search');
    // The 9 user-facing checks + enrichment-quality (writes; pages by
    // default though it skips in prod) all page; only the 2 infra checks
    // are excluded. `oidc-authorize` (wxyc-canary#60) is user-facing —
    // login is the DJ-on-air gate for every OIDC client.
    expect(checks.length - paging.size).toBe(2);
    expect(paging.has('gha-runner-online')).toBe(false);
    expect(paging.has('semantic-index-freshness')).toBe(false);
  });
});
