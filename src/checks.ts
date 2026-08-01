import { canaryFetch, CanaryFetchError, type FetchResult } from './client.js';
import { runEnrichmentCheck } from './enrichment-check.js';
import { oidcAuthorize } from './oidc-authorize.js';
import type { Check, CheckContext, CheckResult, DjAuthState, Suite } from './types.js';

/**
 * Narrow `CheckContext.djAuth` to the `signed-in` variant. Every
 * `requiresAuth: true` check calls this at the top of its `run` in place
 * of the old `if (!ctx.djBearerToken) throw new Error('DJ bearer token
 * missing')` guard — which was belt-and-suspenders against the
 * auth-precondition layer in the runner, and now falls out of the
 * discriminated union for free (wxyc-canary#65).
 *
 * If the runner dispatches a `requiresAuth: true` check with a
 * non-signed-in `djAuth`, that's a runner bug (the guards in `runCanary`
 * are supposed to convert those to `skipped` or `fail` outcomes BEFORE
 * calling `run`). This throw preserves the belt-and-suspenders safety
 * that the original per-check `if (!ctx.djBearerToken)` guards
 * expressed — but as a type-narrowing helper so the check body reads
 * `signedIn.jwt` instead of `ctx.djBearerToken!` and TypeScript enforces
 * the narrowing.
 */
function assertDjAuthed(ctx: CheckContext): DjAuthState & { kind: 'signed-in' } {
  if (ctx.djAuth.kind !== 'signed-in') {
    // Same string shape the pre-#65 guards emitted so alert-message
    // regexes in downstream tests continue to match.
    throw new Error('DJ bearer token missing');
  }
  return ctx.djAuth;
}

/**
 * The canonical artist used for read-side probes. Stereolab has been on
 * heavy rotation at WXYC for ~30 years; the catalog has multiple releases
 * indexed under this name, so a search returning zero rows is a real
 * regression rather than a data-shape edge case.
 */
const PROBE_ARTIST = 'Stereolab';

/** Anonymous: control. Confirms BS process is up and the load balancer routes to it. */
const healthcheck: Check = {
  name: 'backend-healthcheck',
  description: 'GET /healthcheck on Backend-Service',
  requiresAuth: false,
  suites: ['smoke'],
  run: async (ctx) => {
    const r = await canaryFetch(`${ctx.backendUrl}/healthcheck`);
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
  },
};

/**
 * Exercises the iOS proxy path through Backend-Service into LML. Catches
 * LML being down/timing out and any regression in the BS proxy controller.
 * Uses the DJ bearer because the proxy route is `requirePermissions({})` —
 * any authed JWT works; we don't need a true anonymous-device session to
 * cover the BS→LML hop.
 */
const proxyLibrarySearch: Check = {
  name: 'proxy-library-search',
  description: 'GET /proxy/library/search — exercises BS → LML',
  requiresAuth: true,
  suites: ['smoke'],
  run: async (ctx) => {
    const auth = assertDjAuthed(ctx);
    const r = await canaryFetch(
      `${ctx.backendUrl}/proxy/library/search?artist=${encodeURIComponent(PROBE_ARTIST)}&limit=5`,
      { headers: { Authorization: `Bearer ${auth.jwt}` } }
    );
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    const body = r.body as { results?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`expected {results: [...]}, got: ${r.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * Anonymous: semantic-index Graph API. Mirrors the iOS searchArtist call
 * and would have caught semantic-index outages. Doesn't catch iOS-side
 * decoder drift on its own — that lives in the iOS test suite — but it
 * does catch the server returning 5xx or shape regressions like
 * `results` disappearing.
 */
const semanticIndexSearch: Check = {
  name: 'semantic-index-search',
  description: 'GET /graph/artists/search on explore.wxyc.org',
  requiresAuth: false,
  // Paging tier (default). Demoted to infra under wxyc-canary#48 DP1 because it
  // flapped every night ~09:00 UTC on in-process sync/rebuild contention;
  // semantic-index#347 moved the rebuild off-host (the in-process daemon that
  // OOM-restarted uvicorn is now disabled), so the surface is reliably green
  // again (verified ≥2 clean nights) and this user-facing availability probe is
  // restored to the page per wxyc-canary#50. Its sibling `semantic-index-freshness`
  // stays infra-tier for now — staleness is degradation, not an outage.
  run: async (ctx) => {
    const r = await canaryFetch(
      `${ctx.semanticIndexUrl}/graph/artists/search?q=${encodeURIComponent(PROBE_ARTIST)}&limit=1`
    );
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    const body = r.body as { results?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`expected {results: [...]}, got: ${r.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * Maximum tolerated age of the served graph DB, in seconds. The
 * semantic-index nightly sync runs at 09:00 UTC, so a graph older than 36 h
 * means at least one scheduled run has missed or failed. 36 h (vs a tight 25 h)
 * absorbs a single skipped/slow run and the canary's own evaluation window
 * before paging the infra tier.
 */
const GRAPH_DB_MAX_AGE_SECONDS = 36 * 60 * 60; // 129_600

/**
 * Absolute floor on the served `artist_count`. Production is ~136,700 and
 * grows monotonically (~250/month — it's a cumulative count of every distinct
 * artist ever played), so 100K sits ~27% below live: legitimate drift can't
 * trip it, but an empty/truncated build fails instantly. Absolute (not
 * relative) because the canary is a stateless Lambda and can't cheaply carry
 * prior-count state. This is the post-swap external backstop — distinct from
 * semantic-index#349's pre-swap relative collapse-fraction gate (the two are
 * complementary; do not import #349's machinery here).
 */
const ARTIST_COUNT_FLOOR = 100_000;

/**
 * Anonymous: semantic-index graph-DB freshness. Polls `GET /health` on
 * explore.wxyc.org and fails when the served graph is stale or empty. The
 * nightly sync can fail completely silently — an OOM/SIGKILL kills the rebuild
 * before the atomic DB swap, bypassing Python's exception machinery, so nothing
 * reaches Sentry. The only trustworthy success signal is the serving-host graph
 * freshness, which this check externally backstops:
 *
 *   - `graph_db_age_seconds` > 36 h → at least one scheduled 09:00 UTC sync
 *     missed/failed (the silent-stale window).
 *   - `artist_count` < 100,000 → a fresh-but-empty/truncated DB that would
 *     otherwise read green.
 *
 * Infra/non-paging tier (`pagesOncall: false`): a served-but-stale graph is a
 * degradation, not an outage — explore.wxyc.org keeps answering, just from an
 * older DB — so it routes to `InfraCheckFailure` / `wxyc-canary-infra-degraded`
 * (not the page). (It also fired every day by design while semantic-index#347's
 * off-host rebuild was unshipped and the nightly OOM could recur; #347 has since
 * landed.) Promotion to `pagesOncall: true` is a separate judgement call — once
 * a stale graph is deemed page-worthy and freshness has held for a sustained
 * window — and is NOT gated on wxyc-canary#50 (which only covers the
 * `semantic-index-search` restore, already done).
 *
 * Keys on serving-host freshness via `/health`, NOT on the build job, so it
 * survives the #347 migration without rework. `graph_db_age_seconds` is added
 * to `/health` by semantic-index#348; until that deploys, prod `/health` only
 * carries `artist_count`, so the age half no-ops in production (the floor half
 * is live today). Returns the age as a `GraphDbAgeSeconds` metric (emitted
 * dimensioned + dimensionless per the org CloudWatch convention) for dashboard
 * trend visibility; the alarm signal is the infra-tier failure aggregate, not
 * a dedicated age alarm.
 */
const semanticIndexFreshness: Check = {
  name: 'semantic-index-freshness',
  description: 'GET /health on explore.wxyc.org — graph_db_age_seconds < 36h and artist_count >= 100k',
  requiresAuth: false,
  // Infra/non-paging tier (semantic-index#348 + wxyc-canary#48): a stale graph
  // is degradation (explore.wxyc.org still answers from an older DB), not a
  // DJ-on-air outage. Failures route to `InfraCheckFailure` /
  // `wxyc-canary-infra-degraded` (low-urgency), NOT the page. Promotion is a
  // separate decision, not gated on #50 — see README "What it checks".
  pagesOncall: false,
  run: async (ctx): Promise<CheckResult | void> => {
    const r = await canaryFetch(`${ctx.semanticIndexUrl}/health`);
    if (!r.ok) {
      throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    }
    const body = r.body as { artist_count?: unknown; graph_db_age_seconds?: unknown };
    if (!body || typeof body !== 'object') {
      throw new Error(`expected a JSON object from /health, got: ${r.rawText.slice(0, 200)}`);
    }

    // Content floor (live today): a fresh-but-empty/truncated DB must not read
    // green. `artist_count` has been on `/health` since before this check.
    if (typeof body.artist_count !== 'number' || !Number.isFinite(body.artist_count)) {
      throw new Error(`expected numeric artist_count on /health, got: ${r.rawText.slice(0, 200)}`);
    }
    if (body.artist_count < ARTIST_COUNT_FLOOR) {
      throw new Error(
        `artist_count ${body.artist_count} is below the ${ARTIST_COUNT_FLOOR} floor — graph DB is empty or truncated`
      );
    }

    // Freshness (gated on semantic-index#348 landing): only assert on the age
    // when `/health` actually carries the field. Until #348 deploys, the field
    // is absent in production and we must NOT synthesize a false stale-graph
    // failure from a missing value — the floor half above is the live signal in
    // the meantime. Tests mock the field in, so the age path is fully covered.
    const ageRaw = body.graph_db_age_seconds;
    // semantic-index#348 emits `graph_db_age_seconds: null` as an explicit
    // "serving graph DB file is absent" sentinel — deliberately distinct from
    // the field being missing entirely (the pre-#348 production shape, handled
    // as a no-op below). An explicit null means there is no graph to serve, so
    // fail closed. Today #348 only emits null alongside a 503, which the `!r.ok`
    // guard above already catches; encoding the contract here keeps the check
    // fail-closed if that ever changes (e.g. null surfacing on a 200). Note
    // `=== null` matches only JSON null, not `undefined`, so the pre-#348
    // missing-field case still falls through to the no-op pass.
    if (ageRaw === null) {
      throw new Error(
        'graph_db_age_seconds is null — the serving graph DB file is absent (semantic-index#348 sentinel)'
      );
    }
    if (typeof ageRaw === 'number' && Number.isFinite(ageRaw)) {
      if (ageRaw > GRAPH_DB_MAX_AGE_SECONDS) {
        throw new Error(
          `graph_db_age_seconds ${Math.round(ageRaw)} exceeds the ${GRAPH_DB_MAX_AGE_SECONDS}s (~36h) limit — the nightly sync has missed or failed (silent-stale window)`
        );
      }
      // Fresh + above floor: surface the age for dashboard trend visibility.
      return { metrics: { GraphDbAgeSeconds: ageRaw } };
    }
    // Floor passed and the age field is absent (pre-#348 prod) or a non-numeric,
    // non-null value: pass without an age metric rather than fabricate one.
  },
};

/**
 * DJ-authenticated: the catalog-search endpoint dj-site uses for
 * autocomplete. This is the exact path that 503'd on 2026-04-30 because of
 * the cached `library.artist_name` precondition. Hitting it under a real
 * DJ JWT reproduces the failure mode that incident exhibited.
 */
const djLibrarySearch: Check = {
  name: 'dj-library-search',
  description: 'GET /library/?artist_name=... as DJ — catches catalog-search 503',
  requiresAuth: true,
  suites: ['smoke'],
  run: async (ctx) => {
    const auth = assertDjAuthed(ctx);
    const r = await canaryFetch(`${ctx.backendUrl}/library/?artist_name=${encodeURIComponent(PROBE_ARTIST)}&n=5`, {
      headers: { Authorization: `Bearer ${auth.jwt}` },
    });
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    if (!Array.isArray(r.body)) {
      throw new Error(`expected array body, got ${typeof r.body}: ${r.rawText.slice(0, 200)}`);
    }
    if ((r.body as unknown[]).length === 0) {
      throw new Error(`expected at least 1 hit for ${PROBE_ARTIST}, got 0 — catalog search is degraded`);
    }
  },
};

/**
 * DJ-authenticated: the flowsheet read endpoint dj-site polls every 60s.
 * Doesn't catch the play_order index incident (that's on POST), but does
 * catch read-side regressions. Targets v1 because v2 (PR #182) isn't
 * deployed yet — flip to `/v2/flowsheet?n=5` once it ships.
 */
const djFlowsheetRead: Check = {
  name: 'dj-flowsheet-read',
  description: 'GET /flowsheet?n=5 as DJ',
  requiresAuth: true,
  suites: ['smoke'],
  run: async (ctx) => {
    const auth = assertDjAuthed(ctx);
    const r = await canaryFetch(`${ctx.backendUrl}/flowsheet?n=5`, {
      headers: { Authorization: `Bearer ${auth.jwt}` },
    });
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
  },
};

/**
 * DJ-authenticated: the rotation dropdown query. Currently this returns a
 * count that omits the 147 active NULL-album_id rows due to the INNER JOIN
 * bug filed as #689. The canary doesn't assert a specific count (that
 * would lock in the bug) but does catch when rotation goes empty entirely
 * or the endpoint 5xx's.
 */
const djRotation: Check = {
  name: 'dj-rotation',
  description: 'GET /library/rotation as DJ',
  requiresAuth: true,
  run: async (ctx) => {
    const auth = assertDjAuthed(ctx);
    const r = await canaryFetch(`${ctx.backendUrl}/library/rotation`, {
      headers: { Authorization: `Bearer ${auth.jwt}` },
    });
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    if (!Array.isArray(r.body)) {
      throw new Error(`expected array body, got ${typeof r.body}: ${r.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * DJ-authenticated: the dj-site rotation picker. On selecting a rotation
 * row in the flowsheet entry UI, dj-site calls `GET /library/rotation/{id}/tracks`
 * to populate a track dropdown. The endpoint was the user-visible failure
 * surface of BS#994 / BS#1030: when LML was under cascade load, individual
 * release-id lookups timed out, the controller short-circuited to 502, and
 * on-air DJs saw "Loading tracks..." that never resolved. BS#1029 made 21%
 * of active rotation rows JOIN-resolvable (no LML call needed), but the
 * remaining ~79% still depend on the runtime cascade — so this probe both
 * pins the JOIN path stays healthy and acts as a leading indicator for the
 * cascade-class regression that surfaced today via on-air Slack messages
 * rather than any monitor.
 *
 * Self-healing target: rather than hardcode a rotation id (which would
 * break when that row gets killed), the probe discovers a candidate from
 * the rotation list itself. Any 2xx + array response is a pass — the body
 * is allowed to be empty because a real release may have zero indexed
 * tracks (e.g., never cross-referenced with Discogs). The 8 s per-fetch
 * timeout in `canaryFetch` is the regression signal: BS#994's cascade was
 * a 30 s timeout chain → 502, so anything that gets within shouting
 * distance of the budget produces a `fail`.
 */
const djRotationPicker: Check = {
  name: 'dj-rotation-picker',
  description: 'GET /library/rotation/{id}/tracks as DJ — catches BS#994 / BS#1030 cascade-to-502 class',
  requiresAuth: true,
  run: async (ctx): Promise<CheckResult | void> => {
    const auth = assertDjAuthed(ctx);
    const list = await canaryFetch(`${ctx.backendUrl}/library/rotation`, {
      headers: { Authorization: `Bearer ${auth.jwt}` },
    });
    if (!list.ok) {
      throw new Error(`rotation list precondition: expected 2xx, got ${list.status}: ${list.rawText.slice(0, 200)}`);
    }
    if (!Array.isArray(list.body)) {
      throw new Error(`rotation list precondition: expected array body, got ${typeof list.body}`);
    }
    const first = list.body[0] as { id?: number } | undefined;
    if (!first || typeof first.id !== 'number') {
      // The dj-rotation check already alerts on an empty rotation; this probe
      // intentionally degrades to skipped so the picker signal doesn't
      // duplicate that one. With rotation empty there's nothing to probe.
      return { skipped: true, skipReason: 'rotation list is empty — no probe target available' };
    }
    const tracks = await canaryFetch(`${ctx.backendUrl}/library/rotation/${first.id}/tracks`, {
      headers: { Authorization: `Bearer ${auth.jwt}` },
    });
    if (!tracks.ok) {
      throw new Error(`expected 2xx, got ${tracks.status}: ${tracks.rawText.slice(0, 200)}`);
    }
    if (!Array.isArray(tracks.body)) {
      throw new Error(`expected array body, got ${typeof tracks.body}: ${tracks.rawText.slice(0, 200)}`);
    }
  },
};

/**
 * Synthetic bearer used by the lml-auth check's known-bad probe. Must NOT
 * match a real bearer pattern — if the real `LML_API_KEY` ever drifted to
 * this value the canary would silently lose the auth-disabled signal. The
 * `wxyc-canary-probe-` prefix keeps any accidental leak grepable and the
 * `not-a-real-key` suffix is the obvious "do not use" marker.
 */
const LML_KNOWN_BAD_BEARER = 'wxyc-canary-probe-not-a-real-key';

/**
 * Direct POST to LML's `/api/v1/lookup` with the production
 * `LML_API_KEY` bearer. Catches `LML_API_KEY` rotation drift in
 * isolation from the BS proxy path: `proxy-library-search` exercises
 * BS→LML through a DJ JWT, so a missing bearer there fails as "BS lost
 * the header" rather than "the LML bearer is stale". This check removes
 * BS from the loop entirely. Layer-1 mitigation for BS#1094 — the
 * silent backfill stall the org saw the last time the bearer was
 * rotated without a coordinated rollout (Sentry per row, no aggregated
 * alarm, predicate didn't know about auth).
 *
 * Two probes per tick:
 *   1. Known-good bearer (`ctx.lmlApiKey`): a 401/403 is the rotation-drift
 *      signal and PAGES. A clean 2xx advances to probe 2.
 *   2. Known-bad bearer (`wxyc-canary-probe-not-a-real-key`): a 200 means
 *      LML's auth flag was disabled or rolled back (LML_REQUIRE_AUTH=false)
 *      and the good-bearer probe alone can't detect that — the broader
 *      regression the parent BS#1094 was filed to catch. It PAGES with a
 *      distinct "auth disabled" message so operator routing differs from
 *      rotation drift (which is "re-coordinate consumer rotation", not
 *      "re-enable LML auth"). A clean 401/403 is the expected pass.
 *
 * This check PAGES ONLY on a definitive auth verdict (good-bearer 401/403,
 * bad-bearer 200). Anything else — a timeout, a network error, a 5xx, a 429,
 * or any other non-2xx that isn't a clean auth rejection — leaves the auth
 * state INDETERMINATE (we can't tell whether the bearer is valid because LML
 * never gave a verdict), so the check returns `skipped` rather than failing.
 * Rationale: LML availability/latency is already a paging surface via
 * `proxy-library-search` (BS→LML) and the dj-* checks, and the cold
 * `/api/v1/lookup` path can exceed the 8s `canaryFetch` budget under load
 * (Apple Music / Spotify / Discogs fan-out; see WXYC/library-metadata-lookup
 * cold-path latency). A timeout there says nothing about the bearer, so this
 * auth probe must not flap the page on it (wxyc-canary alarm-noise, 2026-06-27).
 *
 * Skips when no LML bearer is configured (operator gap, mirrors the
 * DJ-credentials pattern). The probe payload uses a canonical
 * WXYC-representative fixture (Juana Molina / DOGA / la paradoja) from
 * `wxyc-shared`'s example data so the request body is indistinguishable
 * from a real DJ lookup. We don't assert on the `results` shape — that's
 * `proxy-library-search`'s job; this check scopes to "the bearer is
 * accepted and LML answered 2xx" plus "the known-bad bearer is rejected".
 */
const lmlAuth: Check = {
  name: 'lml-auth',
  description:
    'POST /api/v1/lookup directly to LML with LML_API_KEY — catches BS#1094 bearer rotation drift + LML_REQUIRE_AUTH=false',
  requiresAuth: false,
  suites: ['smoke'],
  run: async (ctx): Promise<CheckResult | void> => {
    if (!ctx.lmlApiKey) {
      return { skipped: true, skipReason: 'no LML_API_KEY configured' };
    }
    const body = JSON.stringify({
      artist: 'Juana Molina',
      album: 'DOGA',
      song: 'la paradoja',
      raw_message: 'Juana Molina - la paradoja (DOGA)',
    });

    // Probe 1: known-good bearer. A timeout/network error means LML never
    // answered — auth state is indeterminate, not drifted — so abstain
    // (skipped) rather than page. LML being slow/down is already a paging
    // surface elsewhere; this auth probe must not flap the page on the cold
    // `/api/v1/lookup` exceeding the 8s budget.
    let good: FetchResult;
    try {
      good = await canaryFetch(`${ctx.lmlUrl}/api/v1/lookup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.lmlApiKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      if (err instanceof CanaryFetchError) {
        return {
          skipped: true,
          skipReason: `LML did not answer the good-bearer probe (${err.message}); auth state indeterminate`,
        };
      }
      throw err;
    }
    if (good.status === 401 || good.status === 403) {
      // Distinct message so the operator sees "rotation drift" not "LML
      // down". The bearer is rolled across BS + rom + tubafrenzy + canary;
      // a 401/403 here means at least one of those is wedged the same way.
      throw new Error(
        `LML rejected bearer with ${good.status} (likely LML_API_KEY rotation drift): ${good.rawText.slice(0, 200)}`
      );
    }
    if (!good.ok) {
      // Not a clean 2xx and not a clean auth rejection (5xx, 429, 400, ...).
      // That tells us LML is unhealthy, not that the bearer drifted, so the
      // auth verdict is indeterminate — abstain rather than page.
      return {
        skipped: true,
        skipReason: `LML good-bearer probe got ${good.status} (not 2xx, not 401/403); auth state indeterminate: ${good.rawText.slice(0, 200)}`,
      };
    }

    // Probe 2: known-bad bearer must be rejected. Catches LML_REQUIRE_AUTH
    // being flipped off or rolled back — the silent regression the
    // good-bearer probe alone can't see. Same abstain-on-indeterminate rule.
    let bad: FetchResult;
    try {
      bad = await canaryFetch(`${ctx.lmlUrl}/api/v1/lookup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${LML_KNOWN_BAD_BEARER}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      if (err instanceof CanaryFetchError) {
        return {
          skipped: true,
          skipReason: `LML did not answer the known-bad-bearer probe (${err.message}); auth state indeterminate`,
        };
      }
      throw err;
    }
    if (bad.status === 200) {
      // LML accepted a deliberately-bad bearer — auth is disabled upstream.
      // Operator routing differs from rotation drift: this is "re-enable
      // LML auth" (a regression), not "rotate the shared secret".
      throw new Error(
        `LML accepted known-bad bearer with 200 — auth disabled upstream (LML_REQUIRE_AUTH likely flipped to false): ${bad.rawText.slice(0, 200)}`
      );
    }
    if (bad.status !== 401 && bad.status !== 403) {
      // Neither a clean "auth enabled" (401/403) nor the "auth disabled"
      // (200) signal — a 5xx/429/etc. The auth verdict is indeterminate, so
      // abstain rather than page (LML health is covered by other checks).
      return {
        skipped: true,
        skipReason: `LML known-bad-bearer probe got ${bad.status} (expected 401/403); auth state indeterminate: ${bad.rawText.slice(0, 200)}`,
      };
    }
  },
};

/**
 * Budget for `lml-protected-search`. Tied to the same class-1 timeout
 * Backend-Service's own protected-search caller uses for
 * `/proxy/library/search` (`apps/backend/controllers/proxy.controller.ts`,
 * BS#1826 PR 2 — "class 1 (3s timeout, no budget header), so local catalog
 * search can't be starved by enrichment/batch LML traffic sharing the same
 * default"), rather than the generic 8s `canaryFetch` default every other
 * check uses. LML prod measured this path at p99 41 ms even during a live
 * enrichment-saturation window (BS#1819 close-condition comment,
 * 2026-07-30), so 3s leaves ample headroom while still enforcing the
 * documented SLO instead of a much looser generic ceiling.
 */
const PROTECTED_SEARCH_TIMEOUT_MS = 3000;

/**
 * Anonymous (LML-bearer-gated): direct-to-LML probe of the BS#1819
 * "protected local-search" path — `GET /api/v1/library/search`. LML#929
 * proved this handler invokes zero Discogs/Apple/streaming/enrichment code
 * (a guard test in LML's own suite), so this check's pass/fail is a
 * first-class, isolated signal of local-catalog-search health, decoupled
 * from any enrichment/upstream degradation by construction.
 *
 * Deliberately bypasses Backend-Service and calls LML directly, unlike
 * `proxy-library-search`. As of BS#1826 PR 2, `/proxy/library/search`
 * degrades to `{results: [], total: 0}` on any LML error instead of
 * surfacing it — a correct DJ-facing UX contract (the search box never
 * shows an error toast), but one that means `proxy-library-search` alone
 * can no longer detect an LML-side local-search regression: a timed-out or
 * 5xx LML response still reads as a clean 200 with an empty (but
 * shape-valid) `results` array through the BS proxy. This check closes
 * that gap by hitting LML with the shared service bearer and asserting a
 * genuine hit for the probe artist, the same non-empty assertion
 * `dj-library-search` already uses for the BS-fronted path.
 *
 * Pairs with `lml-enrichment-lookup` below — together they are the
 * BS#1819 isolation-contract canaries: this one is expected to stay green
 * while that one is failing or degraded (see the wxyc-canary#82 isolation
 * regression tests in `test/handler.test.ts`).
 *
 * Skips when no LML_API_KEY is configured (operator gap, mirrors lml-auth).
 */
const lmlProtectedSearch: Check = {
  name: 'lml-protected-search',
  description: 'GET /api/v1/library/search directly on LML — BS#1819 protected local-search path',
  requiresAuth: false,
  run: async (ctx): Promise<CheckResult | void> => {
    if (!ctx.lmlApiKey) {
      return { skipped: true, skipReason: 'no LML_API_KEY configured' };
    }
    const r = await canaryFetch(
      `${ctx.lmlUrl}/api/v1/library/search?artist=${encodeURIComponent(PROBE_ARTIST)}&limit=5`,
      { headers: { Authorization: `Bearer ${ctx.lmlApiKey}` }, timeoutMs: PROTECTED_SEARCH_TIMEOUT_MS }
    );
    if (!r.ok) throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    const body = r.body as { results?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`expected {results: [...]}, got: ${r.rawText.slice(0, 200)}`);
    }
    if (body.results.length === 0) {
      throw new Error(`expected at least 1 hit for ${PROBE_ARTIST}, got 0 — protected local search is degraded`);
    }
  },
};

/**
 * Canonical WXYC-representative fixture for `lml-enrichment-lookup` — the
 * same artist/album/song `lml-auth` already probes (a real combination
 * LML's Discogs cross-referencing should resolve, so the probe exercises
 * actual matching rather than short-circuiting on empty input), but with a
 * distinct `raw_message` tag. The two checks legitimately share both the
 * URL and the bearer (both read `ctx.lmlApiKey`), so the tag is what lets
 * LML-side logs — and this repo's own tests — tell the two checks' traffic
 * apart despite the otherwise-identical request.
 */
const ENRICHMENT_LOOKUP_BODY = JSON.stringify({
  artist: 'Juana Molina',
  album: 'DOGA',
  song: 'la paradoja',
  raw_message: 'wxyc-canary lml-enrichment-lookup probe: Juana Molina - la paradoja (DOGA)',
});

/**
 * Anonymous (LML-bearer-gated): direct-to-LML probe of the BS#1819
 * "enrichment/Discogs-dependent" lane — `POST /api/v1/lookup` with a
 * canonical WXYC fixture. Distinct by design from `lml-protected-search`
 * above: together the pair proves the isolation contract PRD'd in BS#1819
 * — local search must stay green while this lane degrades, and this
 * lane's own degradation must be independently observable rather than
 * folded into a generic timeout.
 *
 * Unlike `lml-auth` (which probes the same endpoint but only cares about
 * the auth verdict, abstaining on anything else), this check's whole
 * purpose IS the lane's health, so it reads the response differently:
 *
 *   - A network error/timeout, a non-2xx, or a malformed body is a HARD
 *     fail (throws) — the enrichment lane failed to answer at all, which
 *     pages via the shared `wxyc-canary-check-failure` alarm same as any
 *     other check. Unlike `lml-auth`'s abstain-on-timeout posture, LML
 *     unresponsiveness here IS the signal this check exists to catch, not
 *     noise to filter out.
 *   - A 2xx response with `degraded: true` or `timeout: true` — the
 *     `LookupResponse` fields library-metadata-lookup#930 added, in part
 *     for this canary (see LML `generated/api_models.py`'s
 *     `degraded_reason` docstring) — is a SOFT signal: LML answered but
 *     deliberately shed the enrichment tail (deadline/admission pressure)
 *     or hit its internal hard cap. That is expected, occasional behavior
 *     under real Discogs pressure (the PRD: "Discogs-dependent enrichment
 *     may degrade when Discogs or another upstream is rate limited"), so
 *     the check itself still `pass`es. The signal is carried entirely by
 *     the `LookupDegraded` metric (0/1, emitted dimensioned +
 *     dimensionless per the org convention) and a dedicated 3-of-3
 *     `template.yaml` alarm (`wxyc-canary-lml-enrichment-degraded`),
 *     mirroring `lml-discogs-breaker-shed`'s metric-carries-the-signal
 *     pattern: a single degraded tick is expected noise, sustained
 *     degradation over ~15 minutes is the page-worthy signature.
 *   - A 2xx response with empty `results` and neither flag set is an
 *     unexplained miss on a fixture that should always resolve — a hard
 *     fail, matching `dj-library-search`'s "expected at least 1 hit"
 *     precedent for the same reasoning.
 *
 * Skips when no LML_API_KEY is configured (operator gap, mirrors lml-auth).
 */
const lmlEnrichmentLookup: Check = {
  name: 'lml-enrichment-lookup',
  description: 'POST /api/v1/lookup directly on LML — BS#1819 Discogs-dependent enrichment lane',
  requiresAuth: false,
  run: async (ctx): Promise<CheckResult | void> => {
    if (!ctx.lmlApiKey) {
      return { skipped: true, skipReason: 'no LML_API_KEY configured' };
    }
    let r: FetchResult;
    try {
      r = await canaryFetch(`${ctx.lmlUrl}/api/v1/lookup`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.lmlApiKey}`,
          'Content-Type': 'application/json',
        },
        body: ENRICHMENT_LOOKUP_BODY,
      });
    } catch (err) {
      if (err instanceof CanaryFetchError) {
        throw new Error(`LML did not answer /api/v1/lookup (${err.message}) — enrichment lane unresponsive`);
      }
      throw err;
    }
    if (!r.ok) {
      throw new Error(`expected 2xx, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    }
    const body = r.body as { results?: unknown; degraded?: unknown; timeout?: unknown };
    if (!body || typeof body !== 'object' || !Array.isArray(body.results)) {
      throw new Error(`expected {results: [...]}, got: ${r.rawText.slice(0, 200)}`);
    }
    const shedding = body.degraded === true || body.timeout === true;
    if (body.results.length === 0 && !shedding) {
      throw new Error(
        `expected at least 1 match for the canonical fixture, got 0 (degraded=false, timeout=false) — enrichment/matching regression: ${r.rawText.slice(0, 200)}`
      );
    }
    return { metrics: { LookupDegraded: shedding ? 1 : 0 } };
  },
};

/**
 * LML `/health` values of `discogs_breaker_state` that mean the
 * saturation-protection breaker is shedding Discogs lookup traffic.
 * `half-open` still sheds every caller except the breaker's own one
 * in-flight trial request, so it counts alongside `open`. `closed` and
 * `null` (Discogs unconfigured — never expected on prod) do not.
 */
const DISCOGS_BREAKER_SHEDDING_STATES = new Set(['open', 'half-open']);

/**
 * Anonymous: detects when LML's Discogs-saturation breaker is shedding
 * lookup traffic. `GET /health` on LML surfaces the breaker's raw state as
 * top-level `discogs_breaker_state` (`"closed" | "open" | "half-open" |
 * null` — library-metadata-lookup#939, merged 2026-07-27). Key on this raw
 * field, not the derived `services.discogs_api: "rate-limited"` — the raw
 * field is authoritative and #939's own docs recommend it.
 *
 * This check's pass/fail status NEVER reflects the breaker state — it
 * always returns `pass` and carries the shed signal entirely in the
 * `DiscogsBreakerShedding` metric (0 or 1), emitted dimensioned +
 * dimensionless per the `{ metrics: {...} }` convention. That's
 * deliberate: a dedicated `template.yaml` alarm on the dimensionless
 * series (`Statistic: Maximum`, `EvaluationPeriods: 3`,
 * `DatapointsToAlarm: 3`) is what pages after 3 consecutive shedding
 * ticks (~15 minutes) — a breaker legitimately trips OPEN for a window or
 * two during real saturation, so 3-of-3 is the "never recovers" signature,
 * distinct from the shared `wxyc-canary-check-failure` alarm's 2-of-3.
 * Routing the shed through `CheckFailure` / `UserFacingCheckFailure`
 * instead would double-debounce against that aggregate's own evaluation
 * window and page on its schedule rather than this signal's.
 *
 * A network error, non-200, or an unparseable/missing/non-string
 * `discogs_breaker_state` is treated as *indeterminate* — the same
 * abstain-on-indeterminate posture `lml-auth` and `semantic-index-freshness`
 * use for an unreachable dependency — and reads as NOT shedding
 * (`DiscogsBreakerShedding: 0`) rather than paging on an inability to read
 * LML. LML availability itself is already a paging surface via
 * `proxy-library-search` and the dj-* checks.
 *
 * VOLUME GATE (wxyc-canary#84) — the idle-tail false positive is now
 * HANDLED, not accepted. The breaker's `open -> half-open` recovery
 * transition (and the LML#787 watchdog) only advance inside
 * `allow_request()`, which only the live `/lookup` path calls — reading
 * `.state` via `/health` never advances it, so after a genuine OPEN trip
 * with no live Discogs lookups following (an overnight quiet window —
 * cache-hit library searches do not count), `.state` stays latched `open`
 * indefinitely even though the next real lookup would likely recover it.
 * This check also reads `discogs_live_requests_total`
 * (library-metadata-lookup#940, merged to LML `main`) — a monotonic
 * counter of live Discogs-request attempts, including breaker-shed ones —
 * and emits it as `DiscogsLiveRequestsTotal`. The Lambda is stateless
 * across ticks, so it cannot itself diff the counter; instead
 * `DiscogsBreakerShedAlarm` in `template.yaml` computes `DIFF()` on the
 * CloudWatch series and only pages when the breaker is shedding AND the
 * counter is advancing — a flat counter under sustained shed (the idle
 * tail) no longer pages. See that alarm's comment for the full mechanism.
 * The total is emitted ONLY when the field is a `number`; on the three
 * indeterminate branches above (network error / non-200 /
 * missing-or-non-string `discogs_breaker_state`), the metric is omitted
 * entirely (never a fabricated `0`) — a fabricated `0` would make
 * `DIFF()` misread "LML just became reachable again" as a traffic spike.
 * Backward-compatible: an LML that predates #940 simply never has the key
 * in its `/health` body, which reads identically to "indeterminate" here.
 *
 * On-call response to this alarm: do NOT rely on `/health` alone to judge
 * recovery — verify via `api.discogs.com` spans resuming in Sentry
 * instead. Sentry stores `span.domain` wildcard-normalized: query
 * `span.domain:*.discogs.com`, NOT the literal `span.domain:api.discogs.com`
 * — the literal-subdomain filter returns zero rows even while live traffic
 * is flowing (it produced a false "still latched" reading during the
 * 2026-07-14 post-fix verification). `span.op:http.client` grouped by
 * `span.domain` is the reliable shape.
 */
const lmlDiscogsBreakerShed: Check = {
  name: 'lml-discogs-breaker-shed',
  description: 'GET /health on LML — discogs_breaker_state open/half-open means Discogs lookups are being shed',
  requiresAuth: false,
  pagesOncall: true,
  run: async (ctx): Promise<CheckResult> => {
    let r: FetchResult;
    try {
      r = await canaryFetch(`${ctx.lmlUrl}/health`);
    } catch (err) {
      if (err instanceof CanaryFetchError) {
        // LML never answered — breaker state (and live-request volume) is
        // indeterminate, not shedding. LML availability is covered
        // elsewhere (proxy-library-search, dj-* checks); this probe must
        // not page on top of that.
        return { metrics: { DiscogsBreakerShedding: 0 } };
      }
      throw err;
    }
    if (!r.ok) {
      // Non-200: indeterminate, same abstain posture as the network-error
      // branch above.
      return { metrics: { DiscogsBreakerShedding: 0 } };
    }
    const body = r.body as { discogs_breaker_state?: unknown; discogs_live_requests_total?: unknown };
    if (!body || typeof body !== 'object' || typeof body.discogs_breaker_state !== 'string') {
      // Missing field, non-JSON body, or an unexpected type: indeterminate.
      return { metrics: { DiscogsBreakerShedding: 0 } };
    }
    const shedding = DISCOGS_BREAKER_SHEDDING_STATES.has(body.discogs_breaker_state);
    const metrics: NonNullable<CheckResult['metrics']> = { DiscogsBreakerShedding: shedding ? 1 : 0 };
    // discogs_live_requests_total (library-metadata-lookup#940): emit ONLY
    // when it's a non-negative integer — the contract LML#940 guarantees for
    // this monotonic counter. An older LML that doesn't return the field yet,
    // or any shape/contract drift (missing, non-numeric, negative, or
    // fractional), abstains — see the docstring above for why a fabricated or
    // out-of-contract value would corrupt the alarm's DIFF() (e.g. a stray
    // negative followed by a real value reads as a spurious positive delta).
    const liveTotal = body.discogs_live_requests_total;
    if (typeof liveTotal === 'number' && Number.isInteger(liveTotal) && liveTotal >= 0) {
      metrics.DiscogsLiveRequestsTotal = liveTotal;
    }
    return { metrics };
  },
};

/**
 * Shared `skipped` result for every GitHub rate-limit shape the runner-
 * liveness probe can hit (403-primary/secondary and bare 429). All are the
 * same "GitHub couldn't answer this cycle" class as the 5xx / network-error
 * abstain (wxyc-canary#86): the probe never got a runner-liveness verdict, so
 * it abstains rather than failing (wxyc-canary#88). `waitHint` carries whatever
 * wait-time signal GitHub supplied — the `X-RateLimit-Reset` epoch on a 403,
 * the `Retry-After` seconds on a 429 — so the two call sites can't drift.
 * Phrased to keep the on-call away from PAT-rotation: the PAT is valid; the
 * bucket needs to refill.
 */
function githubRateLimitSkip(rawText: string, waitHint: string): CheckResult {
  return {
    skipped: true,
    skipReason: `GitHub rate limit exceeded${waitHint} — wait for the bucket to reset; the PAT is valid: ${rawText.slice(0, 200)}`,
  };
}

/**
 * Liveness probe for the EC2-hosted self-hosted GitHub Actions runner
 * (label `e2e-runner`) that backs the staging-gate suites in
 * Backend-Service, library-metadata-lookup, and dj-site. Wired up as
 * part of WXYC/wiki#80 phase 1; the runner bootstrap + runbook live in
 * wxyc-shared (`scripts/e2e-runner/`).
 *
 * Probe: `GET /orgs/{org}/actions/runners/{id}` with a fine-scoped PAT.
 * Pass on `status === "online"`. Fail on any other status (`offline`
 * is the spec's primary failure mode), 404 (runner id no longer exists
 * after a host replacement that didn't re-set the stack parameter), 401
 * (PAT revoked), or a genuine non-rate-limit 403 (PAT rejection) — all
 * four are determinate, WXYC-actionable verdicts.
 *
 * A GitHub-API 5xx, a network error/timeout reaching github.com, or a
 * rate-limit response are NOT among those: all three mean GitHub itself
 * couldn't answer (or wouldn't, this cycle), which says nothing about
 * the runner's liveness. All abstain (`skipped`, indeterminate) instead
 * of failing — the 5xx/network-error class landed in wxyc-canary#86;
 * rate-limit joined in wxyc-canary#88 (mirrors the `lml-auth`
 * abstain-on-indeterminate pattern from wxyc-canary#58). GitHub returns
 * rate-limit two ways, and both can arrive at either status code: a
 * primary rate-limit is usually 403 with `X-RateLimit-Remaining: 0`; a
 * secondary rate-limit is sometimes a 403 with "secondary rate" in the
 * body, sometimes a bare 429 (often with `Retry-After`). The 403 branch
 * matches all of `remaining === '0'`, `"rate limit"`, and `"secondary
 * rate"` in the body, so it covers every 403-shaped rate-limit; a bare
 * 429 is handled as its own branch since it skips the 403 wrapper
 * entirely. The real signal is fully preserved: a genuinely-offline
 * runner still returns HTTP 200 with `{"status":"offline"}`, which
 * still fails. Trade-off accepted: a prolonged GitHub outage or
 * rate-limit window masks a genuinely-offline runner for its duration —
 * this is infra-tier / low-urgency, and a truly-dead runner resurfaces
 * the moment GitHub recovers or the bucket refills (200 + `offline`).
 *
 * This check is infra-tier (`pagesOncall: false`, see below), so its
 * failures feed the low-urgency `wxyc-canary-infra-degraded` alarm — NOT
 * the `wxyc-canary-check-failure` page. That alarm's 3 evaluations ×
 * 5 min, 2 datapoints-to-alarm window gives the spec's "≥10 minutes of
 * `status != online`" sustained breach for free; it shares the exact
 * shape of the page alarm, just on the infra series.
 *
 * Skip semantics mirror `lml-auth` / DJ credentials: missing PAT or
 * runner-id is an operator gap (alarm stays quiet); a 404, 401, or a
 * genuine non-rate-limit 403, or a downstream credential-resolution
 * error fails (real signal — surfaced on the low-urgency
 * `wxyc-canary-infra-degraded` alarm, not the page, since this check is
 * `pagesOncall: false`); a GitHub 5xx, an unreachable github.com, or any
 * rate-limit response (403-primary, 403-secondary, or bare 429)
 * abstains (skipped) as described above.
 */
const ghaRunnerOnline: Check = {
  name: 'gha-runner-online',
  description: 'GET /orgs/{org}/actions/runners/{id} — staging-gate runner liveness',
  requiresAuth: false,
  // Infra/non-paging tier (wxyc-canary#48 DP2): the self-hosted CI runner is
  // an operator concern, not a DJ-facing surface, and a runner offline (or a
  // PAT/rate-limit hiccup) shouldn't page on-call at 3am. Failures route to
  // `InfraCheckFailure` and the low-urgency `wxyc-canary-infra-degraded`
  // alarm. The probe is still valuable — it catches a queued staging-gate
  // job waiting on a dead runner that GitHub itself never notifies on.
  pagesOncall: false,
  run: async (ctx): Promise<CheckResult | void> => {
    // Check the runner-id sentinel before the token: when both are missing
    // the id is the load-bearing knob (a configured probe without a token
    // would fail to resolve; a configured token without an id would have
    // nothing to probe). Surfacing "no runner id" first matches the
    // dominant operator failure mode.
    //
    // Defense-in-depth on the runner-id sentinel. The CFN HasGhaRunnerProbe
    // condition strips the env var to '' when GhaRunnerId=0; the env loader
    // turns '' into undefined. But non-CFN deploy paths (local invoke, manual
    // env override, a future template refactor) can land NaN (typo) or 0
    // (sentinel) or non-positive-integer values. `typeof NaN === 'number'`
    // and `typeof 0 === 'number'`, so a bare `typeof !== 'number'` is not
    // enough — without isInteger/`> 0` the URL would template `/runners/NaN`
    // or `/runners/0` and 404, mis-routing to "runner was likely replaced".
    if (typeof ctx.ghaRunnerId !== 'number' || !Number.isInteger(ctx.ghaRunnerId) || ctx.ghaRunnerId <= 0) {
      return {
        skipped: true,
        skipReason:
          ctx.ghaRunnerId === undefined
            ? 'no runner id configured (CANARY_GHA_RUNNER_ID)'
            : `invalid runner id (CANARY_GHA_RUNNER_ID=${ctx.ghaRunnerId}); expected positive integer`,
      };
    }
    if (!ctx.ghaRunnerToken) {
      return { skipped: true, skipReason: 'no GitHub PAT configured for runner-liveness probe' };
    }
    // Normalize a trailing slash on the API base. Operator copy-paste
    // hazard — GH today tolerates `//orgs/...` but a path-strict proxy or
    // future GH rev would 404 and the failure would mis-route through the
    // "runner replaced" runbook.
    const apiBase = ctx.ghaRunnerApiBase.replace(/\/+$/, '');
    const url = `${apiBase}/orgs/${ctx.ghaRunnerOrg}/actions/runners/${ctx.ghaRunnerId}`;
    let r: FetchResult;
    try {
      r = await canaryFetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.ghaRunnerToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (err) {
      if (err instanceof CanaryFetchError) {
        // github.com never answered (network error or timeout) — exactly
        // as indeterminate as the 5xx branch below, same abstain rationale.
        return {
          skipped: true,
          skipReason: `GitHub did not answer the runner-liveness probe (${err.message}); runner status indeterminate`,
        };
      }
      throw err;
    }
    if (r.status === 404) {
      // Runner id no longer exists — the operator replaced the host and
      // did not re-set the CFN parameter. Distinct from "offline" so the
      // on-call routes to the replacement runbook, not "the runner died".
      // NOTE: a fine-scoped PAT with insufficient scope ALSO returns 404
      // (GitHub hides resources from underprivileged tokens). The runbook
      // entry for this message must mention the PAT-scope possibility as a
      // second-line check after the operator confirms the runner id.
      throw new Error(
        `GitHub returned 404 for runner id ${ctx.ghaRunnerId} — runner was likely replaced (or PAT lacks Self-hosted runners: Read scope); re-set GhaRunnerId or rotate PAT: ${r.rawText.slice(0, 200)}`
      );
    }
    if (r.status === 403) {
      // 403 is overloaded: primary rate-limit returns 403 with `X-RateLimit-
      // Remaining: 0` and a body mentioning "rate limit". PAT rotation
      // drift returns 403 too. Disambiguate so on-call doesn't rotate a
      // perfectly valid PAT chasing a transient rate-limit window.
      const remaining = r.headers?.['x-ratelimit-remaining'];
      const bodyText = r.rawText.toLowerCase();
      if (remaining === '0' || bodyText.includes('rate limit') || bodyText.includes('secondary rate')) {
        // A rate-limit is the same "GitHub couldn't answer" class as the
        // 5xx / network-error abstain below (wxyc-canary#86): the probe
        // never got a runner-liveness verdict this cycle, so it abstains
        // rather than failing (wxyc-canary#88, option (a) — see also the
        // bare-429 branch below, which covers the secondary-rate-limit
        // shape that skips this 403 wrapper entirely). Surface the
        // `X-RateLimit-Reset` epoch as the wait-time hint when GitHub
        // supplies it.
        const reset = r.headers?.['x-ratelimit-reset'];
        return githubRateLimitSkip(r.rawText, reset ? ` (reset epoch ${reset})` : '');
      }
      throw new Error(
        `GitHub rejected PAT with 403 — rotate the runner-liveness PAT in SSM: ${r.rawText.slice(0, 200)}`
      );
    }
    if (r.status === 401) {
      // PAT is revoked / expired / malformed. Operator action: rotate the
      // SSM parameter — different runbook entry from "runner down" or "rate
      // limit".
      throw new Error(
        `GitHub rejected PAT with 401 — rotate the runner-liveness PAT in SSM: ${r.rawText.slice(0, 200)}`
      );
    }
    if (r.status === 429) {
      // Secondary rate-limit sometimes arrives as a bare 429 — no 403
      // wrapper, so it skips the heuristic above entirely — often with a
      // `Retry-After` header. Same indeterminate-abstain rationale as the
      // 403-rate-limit branch above and the 5xx branch below
      // (wxyc-canary#88): the probe never got a runner-liveness verdict.
      // Surface the parsed `Retry-After` seconds (via the typed
      // `retryAfterMs` accessor — wxyc-canary#64) as the wait-time hint so
      // the operator gets the same "how long" signal the 403 path's reset
      // epoch provides; fall back to a bare `(429)` marker when absent.
      const waitHint = r.retryAfterMs !== undefined ? ` (retry after ${Math.round(r.retryAfterMs / 1000)}s)` : ' (429)';
      return githubRateLimitSkip(r.rawText, waitHint);
    }
    if (r.status >= 500) {
      // GitHub itself is degraded — the probe simply couldn't get an
      // answer, which says nothing about the runner's liveness. Abstain
      // rather than fail: a `fail` here would trip both the low-urgency
      // infra-degraded alarm and (via the handler's unconditional throw
      // on any failed check) the page-tier lambda-errors alarm, for a
      // condition with zero WXYC signal. A genuinely-offline runner still
      // returns HTTP 200 with {"status":"offline"} (see below), so that
      // real signal is fully preserved (wxyc-canary#86).
      return {
        skipped: true,
        skipReason: `GitHub API degraded (status ${r.status}) — indeterminate, cannot verify runner liveness; check githubstatus.com: ${r.rawText.slice(0, 200)}`,
      };
    }
    if (!r.ok) {
      throw new Error(`expected 2xx from GitHub runner endpoint, got ${r.status}: ${r.rawText.slice(0, 200)}`);
    }
    const body = r.body as { status?: string; name?: string; id?: number };
    if (!body || typeof body !== 'object' || typeof body.status !== 'string') {
      throw new Error(`expected {status: string} from GitHub runner endpoint, got: ${r.rawText.slice(0, 200)}`);
    }
    if (body.status !== 'online') {
      // The spec's primary failure mode: the runner stopped polling
      // GitHub (host wedge, systemd unit died, network egress to
      // github.com broken). Include the human-readable name so the
      // alarm message points the on-call at the right host.
      throw new Error(
        `runner ${body.name ?? `id=${ctx.ghaRunnerId}`} is offline (status="${body.status}") — investigate per scripts/e2e-runner/README.md`
      );
    }
  },
};

/**
 * Write canary (v1). Inserts a sentinel flowsheet row, polls until LML
 * enrichment populates `youtube_music_url`, deletes the row, ends the
 * canary's show. Returns an `EnrichmentLagSeconds` metric the runner
 * publishes as the `EnrichmentLag` CloudWatch series the
 * `wxyc-canary-enrichment-lag` alarm targets.
 *
 * Opt-in via `CANARY_ENABLE_WRITE_PROBE=true` (default off). With the flag
 * off, the runner downgrades this check to skipped — keeps existing
 * deployments unchanged and lets the rollout proceed environment-by-env.
 *
 * Built for the 2026-05-13 LML cascade regression that left 70% of new
 * playcut entries with null metadata for 2+ days while the read-only
 * checks (`proxy-library-search`, `dj-flowsheet-read`) all stayed green
 * — same shapes, just no enrichment behind them.
 */
const enrichmentQuality: Check = {
  name: 'enrichment-quality',
  description: 'Insert sentinel track + poll until LML enrichment populates youtube_music_url',
  requiresAuth: true,
  writes: true,
  run: async (ctx) => runEnrichmentCheck(ctx),
};

export const checks: readonly Check[] = [
  healthcheck,
  proxyLibrarySearch,
  semanticIndexSearch,
  semanticIndexFreshness,
  djLibrarySearch,
  djFlowsheetRead,
  djRotation,
  djRotationPicker,
  lmlAuth,
  lmlProtectedSearch,
  lmlEnrichmentLookup,
  lmlDiscogsBreakerShed,
  ghaRunnerOnline,
  enrichmentQuality,
  oidcAuthorize,
];

/**
 * The complete set of suite tags accepted by the CLI's `--suite` flag. The
 * `satisfies` clause forces a compile error if a string here drifts from
 * the `Suite` union, and the `as const` makes the array readable as a
 * literal type so the CLI can list valid values in error messages.
 *
 * Add a new suite by extending the `Suite` union in types.ts, appending
 * here, and tagging the relevant checks. The CLI's `--suite` validator
 * reads this constant — no third place to update.
 */
export const VALID_SUITES = ['smoke'] as const satisfies readonly Suite[];

/**
 * Exhaustiveness check: the type below errors at compile time when a
 * member of the `Suite` union is missing from `VALID_SUITES`. The
 * `satisfies` clause above enforces the other direction (every entry
 * in `VALID_SUITES` is a valid `Suite`); together they pin the two in
 * lock-step. Without this, extending `Suite = 'smoke' | 'dj-site'`
 * without bumping `VALID_SUITES` would type-check cleanly and the CLI
 * would reject `--suite=dj-site` as unknown at runtime.
 */
type _ExhaustivenessCheck =
  Exclude<Suite, (typeof VALID_SUITES)[number]> extends never
    ? true
    : 'Suite union has a member missing from VALID_SUITES';
const _exhaustivenessCheck: _ExhaustivenessCheck = true;
// Silence "declared but never read" — the assignment site is the assertion.
void _exhaustivenessCheck;

/**
 * Return the checks tagged with the given suite. Untagged checks (no
 * `suites` field) are unreachable from the CLI by design. "Untagged" reflects
 * CLI-reachability ONLY, and that axis is independent of the paging tier:
 *
 *   (1) CLI-reachability — some untagged checks are prod-only operator
 *       concerns (`gha-runner-online`), writes (`enrichment-quality`), or
 *       probe a different service (`semantic-index-search`); the staging-gate
 *       CLI has no business running them.
 *   (2) Paging tier — `dj-rotation` and `dj-rotation-picker` are ALSO untagged
 *       (left out of `smoke` for staging-gate flakiness reasons) but are
 *       genuinely user-facing and page on-call.
 *
 * So the `suites` tag is a CLI-reachability axis only; paging tier is
 * determined by `pagesOncall` in the check definition (default true; false
 * only for the two infra probes). The Lambda continues to consume the full
 * `checks` array directly, regardless of suite tags.
 */
export function checksForSuite(suite: Suite): readonly Check[] {
  return checks.filter((c) => c.suites?.includes(suite));
}

/**
 * Sign in to better-auth as a DJ and return a JWT suitable for the
 * `Authorization: Bearer ...` header on Backend-Service routes. Throws on
 * any failure — caller is responsible for downgrading DJ-auth checks to
 * skipped when this throws and credentials weren't supplied.
 *
 * Two-step: `/sign-in/email` returns a session token (cookie-equivalent),
 * then `/token` exchanges the session for a JWT. Backend-Service's
 * `requirePermissions` middleware verifies JWTs against the JWKS endpoint,
 * so the session token alone gets a 401 — the exchange is mandatory.
 *
 * `originUrl` is sent as the `Origin` header on both calls. better-auth's
 * CSRF guard rejects sign-in with `MISSING_OR_NULL_ORIGIN` when the header
 * is absent (curl, Lambda, anything non-browser). The value must be one of
 * the auth server's `BETTER_AUTH_TRUSTED_ORIGINS`.
 *
 * Retry carve-out: the canary deliberately does not retry the surfaces it
 * measures (see `client.ts`). Sign-in is the exception, and only on 429.
 * Auth is a precondition shared by 6 of the 11 checks, so a single 429 here
 * cascades into 6 simultaneous fail outcomes plus a Lambda Errors alarm —
 * even when the surfaces being measured are healthy. One retry, only on
 * 429, only on the sign-in step (token exchange does not retry). Honors
 * `Retry-After` (seconds form) when present, capped to 5s so the Lambda
 * still finishes inside its budget.
 */
// `signInDj` returns the successful-shape only: `{ jwt, sessionToken,
// userId }`. Failures throw, and the runner in `handler.ts` wraps that
// into `{ kind: 'precondition-failed', error }` on `CheckContext.djAuth`
// per wxyc-canary#65. `userId` is best-effort: a missing user.id only
// fails the write canary (which throws its own preflight error when the
// `signed-in` variant lacks `userId`). Read-only DJ-auth checks tolerate
// the absence so a better-auth response-shape rev doesn't cascade into
// four false-positive failures.
//
// `sessionToken` is the raw better-auth session token returned from
// `/sign-in/email` (pre-JWT-exchange). The OIDC authorize probe uses it as
// an `Authorization: Bearer ...` header on `/oauth2/authorize` because
// better-auth's `bearer` plugin translates it into the session cookie the
// authorize endpoint reads via `getSessionFromCtx`. Distinct from `jwt`:
// the JWT is what Backend-Service routes accept via `requirePermissions`,
// but `/oauth2/authorize` needs the SESSION, not the JWT (a JWT from
// `/token` fails on authorize — different token audience).
export type DjSignInResult = { jwt: string; userId: string | undefined; sessionToken: string };

export async function signInDj(
  authUrl: string,
  email: string,
  password: string,
  originUrl: string
): Promise<DjSignInResult> {
  const postSignIn = (): Promise<FetchResult> =>
    canaryFetch(`${authUrl}/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: originUrl },
      body: JSON.stringify({ email, password }),
    });

  let signIn = await postSignIn();
  if (signIn.status === 429) {
    const delayMs = Math.min(signIn.retryAfterMs ?? 2000, 5000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    signIn = await postSignIn();
  }
  if (!signIn.ok) {
    throw new Error(`auth sign-in failed with ${signIn.status}: ${signIn.rawText.slice(0, 200)}`);
  }
  const signInBody = signIn.body as { token?: string; user?: { id?: string } };
  if (!signInBody || typeof signInBody.token !== 'string' || signInBody.token.length === 0) {
    throw new Error(`auth sign-in returned no session token: ${signIn.rawText.slice(0, 200)}`);
  }
  const sessionToken = signInBody.token;
  const userId =
    signInBody.user && typeof signInBody.user.id === 'string' && signInBody.user.id.length > 0
      ? signInBody.user.id
      : undefined;

  const tokenExchange = await canaryFetch(`${authUrl}/token`, {
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: originUrl },
  });
  if (!tokenExchange.ok) {
    throw new Error(`auth token exchange failed with ${tokenExchange.status}: ${tokenExchange.rawText.slice(0, 200)}`);
  }
  const tokenBody = tokenExchange.body as { token?: string };
  if (!tokenBody || typeof tokenBody.token !== 'string' || tokenBody.token.length === 0) {
    throw new Error(`auth token exchange returned no JWT: ${tokenExchange.rawText.slice(0, 200)}`);
  }
  return { jwt: tokenBody.token, userId, sessionToken };
}
