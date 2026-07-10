import { createHash, randomBytes } from 'node:crypto';
import { canaryFetch, CanaryFetchError, type FetchResult } from './client.js';
import { runEnrichmentCheck } from './enrichment-check.js';
import type { Check, CheckResult, Suite } from './types.js';

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
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(
      `${ctx.backendUrl}/proxy/library/search?artist=${encodeURIComponent(PROBE_ARTIST)}&limit=5`,
      { headers: { Authorization: `Bearer ${ctx.djBearerToken}` } }
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
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(`${ctx.backendUrl}/library/?artist_name=${encodeURIComponent(PROBE_ARTIST)}&n=5`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
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
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(`${ctx.backendUrl}/flowsheet?n=5`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
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
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const r = await canaryFetch(`${ctx.backendUrl}/library/rotation`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
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
    if (!ctx.djBearerToken) throw new Error('DJ bearer token missing');
    const list = await canaryFetch(`${ctx.backendUrl}/library/rotation`, {
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
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
      headers: { Authorization: `Bearer ${ctx.djBearerToken}` },
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
 * Liveness probe for the EC2-hosted self-hosted GitHub Actions runner
 * (label `e2e-runner`) that backs the staging-gate suites in
 * Backend-Service, library-metadata-lookup, and dj-site. Wired up as
 * part of WXYC/wiki#80 phase 1; the runner bootstrap + runbook live in
 * wxyc-shared (`scripts/e2e-runner/`).
 *
 * Probe: `GET /orgs/{org}/actions/runners/{id}` with a fine-scoped PAT.
 * Pass on `status === "online"`. Fail on any other status (`offline`
 * is the spec's primary failure mode), 404 (runner id no longer exists
 * after a host replacement that didn't re-set the stack parameter),
 * 401/403 (PAT rotation drift), or 5xx (GitHub itself degraded — rare
 * but distinct enough to surface separately).
 *
 * This check is infra-tier (`pagesOncall: false`, see below), so its
 * failures feed the low-urgency `wxyc-canary-infra-degraded` alarm — NOT
 * the `wxyc-canary-check-failure` page. That alarm's 3 evaluations ×
 * 5 min, 2 datapoints-to-alarm window gives the spec's "≥10 minutes of
 * `status != online`" sustained breach for free; it shares the exact
 * shape of the page alarm, just on the infra series.
 *
 * Skip semantics mirror `lml-auth` / DJ credentials: missing PAT or
 * runner-id is an operator gap (alarm stays quiet), but a downstream
 * resolution error fails (real signal — surfaced on the low-urgency
 * `wxyc-canary-infra-degraded` alarm, not the page, since this check is
 * `pagesOncall: false`).
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
    const r = await canaryFetch(url, {
      headers: {
        Authorization: `Bearer ${ctx.ghaRunnerToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
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
        const reset = r.headers?.['x-ratelimit-reset'];
        const resetSuffix = reset ? ` (reset epoch ${reset})` : '';
        // Phrased to keep the on-call away from PAT-rotation actions: the
        // PAT is valid; the bucket needs to refill.
        throw new Error(
          `GitHub rate limit exceeded${resetSuffix} — wait for the bucket to reset; the PAT is valid: ${r.rawText.slice(0, 200)}`
        );
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
    if (r.status >= 500) {
      // GitHub itself is degraded. Route the on-call to githubstatus.com
      // before they SSH the runner or rotate the PAT — the runner has
      // nothing to do with this failure. The docstring above promised this
      // would be a distinct surface; here it actually is.
      throw new Error(
        `GitHub API degraded (status ${r.status}) — check githubstatus.com before investigating the runner: ${r.rawText.slice(0, 200)}`
      );
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

/**
 * Generate a fresh PKCE `code_challenge` per RFC 7636 §4. The verifier is
 * 32 random bytes rendered as urlsafe base64 (43 chars with the padding
 * stripped); the challenge is `base64url(sha256(verifier))`. Node's
 * `randomBytes` is a CSPRNG; the verifier lives for the duration of a
 * single `oidc-authorize` tick and never leaves the process, so any
 * weaker source would already be over-engineered for a canary that
 * doesn't exchange the code.
 *
 * The verifier itself is intentionally NOT returned — the check stops at
 * the /authorize 302 and never exchanges the code, so the verifier's
 * only role is as sha256 input. Returning it would create a call-site
 * temptation to log or reuse it, both of which would defeat the point of
 * PKCE. If a future rev grows a second-tier probe that exchanges the code
 * with a WRONG verifier (to prove the exchange rejects it), that probe
 * should generate its own pair rather than get one leaked back through
 * this helper's return type.
 */
function generatePkcePair(): { challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { challenge };
}

/**
 * Redact the two OIDC secret-adjacent tokens (`code` and `state`) from a
 * string that's about to land in an operator-visible alert. Applied to
 * every diagnostic-carrying string this check emits — 5xx body slices,
 * unexpected-status body slices, `Location` values on the mismatch and
 * missing-code branches, unparseable-Location slices. Both `code` and
 * `state` are covered: `code` is a short-lived but real single-use OAuth
 * credential; `state` is the CSRF barrier — the mismatch branch prints
 * only the mismatch fact, never the returned value, and every sibling
 * error branch must uphold that invariant even when the raw body carries
 * the value.
 *
 * Two shapes are covered because the same value can appear in either a URL
 * query string OR a JSON envelope (better-auth 5xx bodies are JSON):
 *
 *   URL form:  `code=abcd1234`, `state=xyz`
 *              (also matches URL fragments — `#code=abcd1234` — because
 *              the `=` separator is identical to a query-string parameter)
 *   JSON form: strictly quoted-key form only — `"code":"abcd1234"`,
 *              `"state":"xyz"`. Structurally rules out identifier-adjacent
 *              substrings (`errorCode`, `statusCode`, `session_state`,
 *              `oauthConsent`) since those don't have the closing quote
 *              right after `code`/`state`. Ruling those out matters: the
 *              5xx branch's docstring explicitly promises to preserve
 *              `oauthConsent` for BS#1571 routing. Requiring a quoted key
 *              also structurally can't match URL-shape input (which never
 *              has quoted keys), so the URL pass and JSON pass never
 *              double-fire on the same substring.
 *
 * URL-form regexes carry two guards not obvious at a glance:
 *
 *  - Terminator class `[^&\s"'<>]+` includes `&` so the greedy match stops
 *    at the next URL param (without `&`, `code=<redacted>&scope=openid&…`
 *    would swallow the whole tail after the URL pass placeholder,
 *    destroying every downstream OIDC routing signal like `error=…`); and
 *    includes `<`/`>` so HTML-ish 5xx envelopes (`<b>code=REAL</b>`) can't
 *    hide the value behind a tag.
 *  - Negative lookbehind `(?<![A-Za-z0-9_])` prevents substring matches on
 *    identifiers whose tail happens to be `code`/`state` (`errorcode=`,
 *    `session_state=`). Same rationale as the quoted-key JSON form:
 *    preserve identifier-shaped breadcrumbs for on-call routing.
 *
 * Hoisted to module scope so every branch that formats an error message
 * uses the same redaction — a per-call arrow function inside `run` would
 * be re-created every tick and drift silently if a future error branch
 * called its own inline redactor.
 */
const redactCodeAndState = (s: string): string =>
  s
    // URL-shape: `code=<value>` / `state=<value>`. See the docstring above
    // for the terminator + lookbehind rationale.
    .replace(/(?<![A-Za-z0-9_])code=[^&\s"'<>]+/g, 'code=<redacted>')
    .replace(/(?<![A-Za-z0-9_])state=[^&\s"'<>]+/g, 'state=<redacted>')
    // JSON-shape: strictly `"code":"<value>"` / `"state":"<value>"`. The
    // closing quote after `code`/`state` structurally rules out matches on
    // `"errorCode":`, `"statusCode":`, `"session_state":`, `"oauthConsent":`
    // — which is load-bearing: the BS#1571 5xx branch promises to preserve
    // `oauthConsent` as a routing breadcrumb. Case-insensitive because
    // JSON keys are conventionally lowercase but nothing forbids `Code`
    // or `State`. Whitespace tolerance around `:` matches pretty-printed
    // envelopes.
    .replace(/("code"\s*:\s*")[^"]+"/gi, '$1<redacted>"')
    .replace(/("state"\s*:\s*")[^"]+"/gi, '$1<redacted>"');

/**
 * OIDC code + PKCE authorize probe. The load-bearing check that would have
 * caught WXYC/Backend-Service#1571 — the `oauthConsent` schema-drift 500 —
 * before the flowsheet-digitization verifier tripped over it in production.
 * Every future OIDC client (WikiJS, additional in-house tools) rides on the
 * same authorize path, so a regression here is a login-broken-for-everyone
 * outage that's invisible to the existing DJ-bearer/proxy/healthcheck
 * probes.
 *
 * Uses a DEDICATED `wxyc-canary` PUBLIC trusted client (registered in
 * WXYC/Backend-Service#1576). Public client + PKCE means no `client_secret`
 * lives in the canary env — the probe stops at the 302, never exchanges
 * the code, and a leaked canary env carries no OIDC credential.
 *
 * Contract (each tick):
 *   1. Reuse the session token from `signInDj` (already in `ctx.djSessionToken`).
 *   2. GET `/auth/oauth2/authorize?response_type=code&client_id=<probe>
 *      &redirect_uri=<probe-callback>&scope=openid+profile+email
 *      &state=<random>&code_challenge=<S256(v)>&code_challenge_method=S256`
 *      with `Authorization: Bearer <session-token>` (the better-auth
 *      `bearer` plugin translates it to a session cookie) and
 *      `redirect: 'manual'` (so we can inspect the 3xx Location).
 *   3. Assert 302 or 303 (OAuth 2.0 §4.1.2 does not pin the code), Location
 *      matches the probe redirect URI on both `origin` and `pathname`
 *      (strict URL parse — never a `startsWith` on the raw string, which
 *      accepts `https://canary.wxyc.org/authorize-echo-attacker.example.com`
 *      as valid), has a non-empty `code` query param, and echoes the
 *      `state` we sent.
 *
 * Fails on: non-302/303, missing/mismatched state, missing code, Location
 * pointing at a login page or crafted redirect (session invalidated), 5xx,
 * or the exact BS#1571 500 shape. Message truncates to the first 200 chars
 * of body per `healthcheck`'s convention, and runs `redactCodeAndState`
 * against every diagnostic string it emits (5xx and non-3xx body slices,
 * `Location` values on the mismatch and missing-code branches, the
 * unparseable-Location slice). That helper covers both URL-shape
 * (`code=…&state=…`) and JSON-shape (`"code":"…"` / `"state":"…"`)
 * because better-auth 5xx bodies are JSON envelopes; see its own
 * docstring for the exact matching rules. The Set-Cookie header is
 * session-material for the canary DJ and is likewise never logged.
 */
const oidcAuthorize: Check = {
  name: 'oidc-authorize',
  description:
    'GET /auth/oauth2/authorize with PKCE — catches BS#1571 oauthConsent-500 and every OIDC login-broken regression',
  requiresAuth: true,
  suites: ['smoke'],
  // Default paging tier. Login is a DJ-on-air surface — every OIDC client
  // (flowsheet verifier today, WikiJS + others planned) breaks when this
  // path breaks.
  run: async (ctx) => {
    if (!ctx.djSessionToken) {
      // Belt-and-suspenders: the auth-precondition layer already downgrades
      // the check to `fail` when sign-in errored. This branch fires only if
      // `signInDj`'s contract changes and starts returning a result without
      // a session token — a shape rev we want a clear message on, not a
      // confusing "cannot read properties of undefined."
      throw new Error('DJ session token missing (signInDj did not return sessionToken)');
    }
    const { challenge } = generatePkcePair();
    // 16 random bytes → 22-char urlsafe base64. Long enough that a
    // collision within a single tick is astronomical; short enough not to
    // stuff the query string.
    const state = randomBytes(16).toString('base64url');
    const url = new URL(`${ctx.authUrl}/oauth2/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', ctx.oidcProbeClientId);
    url.searchParams.set('redirect_uri', ctx.oidcProbeRedirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const r = await canaryFetch(url.toString(), {
      headers: { Authorization: `Bearer ${ctx.djSessionToken}` },
      redirect: 'manual',
    });

    // A 5xx here is the BS#1571 replay surface: `oauthConsent` schema
    // missing from the Drizzle adapter map → 500. Distinct routing from
    // the 302-but-wrong-Location cases below (that's a login-page bounce,
    // not a substrate-missing error). Include the response body truncation
    // per healthcheck's convention.
    //
    // Redact `code` and `state` before slicing — a 5xx body from a
    // partially-executed authorize handler could contain the code the
    // handler minted just before the 5xx (better-auth today doesn't, but
    // a future rev might, and the docstring promises "never logs the
    // code" without qualification). The redactor covers both URL form
    // (`code=…`) and JSON form (`"code":"…"`) because better-auth 5xx
    // bodies are JSON envelopes. The redaction is body-first + slice so
    // the token can't survive at a truncation boundary.
    if (r.status >= 500) {
      throw new Error(
        `authorize expected 302, got ${r.status} (BS#1571 replay class if body mentions oauthConsent): ${redactCodeAndState(r.rawText).slice(0, 200)}`
      );
    }
    // OAuth 2.0 (RFC 6749 §4.1.2) allows either 302 Found or 303 See Other
    // on the authorization response. better-auth returns 302 today, but the
    // spec doesn't pin it — a future rev switching to 303 would be a
    // legitimate change we must not flap on.
    if (r.status !== 302 && r.status !== 303) {
      throw new Error(`authorize expected 302, got ${r.status}: ${redactCodeAndState(r.rawText).slice(0, 200)}`);
    }

    const location = r.headers?.location;
    if (!location) {
      // 3xx without a Location header is malformed. `canaryFetch` lowercases
      // header names, so this covers `Location:` too.
      throw new Error(`authorize returned ${r.status} with no Location header`);
    }

    let parsed: URL;
    try {
      parsed = new URL(location);
    } catch {
      throw new Error(`authorize 302 Location is not a valid URL: ${redactCodeAndState(location).slice(0, 200)}`);
    }
    // Login-page bounce or crafted-redirect regression: strict origin +
    // pathname comparison rejects both a login-page URL AND the class of
    // prefix-bypass Locations like
    //   https://canary.wxyc.org/authorize-echo-attacker.example.com/?code=X
    // that a naive `location.startsWith(ctx.oidcProbeRedirectUri)` would
    // accept. Parse both sides — origin + pathname compare — so the guard
    // holds regardless of how the Location is stringified (trailing slash,
    // extra path segment, subdomain injection). Distinct message so the
    // on-call routes to session/auth investigation.
    let expected: URL;
    try {
      expected = new URL(ctx.oidcProbeRedirectUri);
    } catch {
      // Should never fire — config-time validation of the redirect URI
      // is out of scope for the runtime check. Fail loudly if it happens.
      throw new Error(
        `oidcProbeRedirectUri is not a valid URL — configuration error: ${ctx.oidcProbeRedirectUri.slice(0, 200)}`
      );
    }
    // Normalize a single trailing slash on both sides before compare — RFC
    // 3986 §6.2.2.3 considers `/authorize-echo` and `/authorize-echo/` the
    // same resource, and if the trusted-client registration and the CFN
    // param drift by a single slash every tick pages on-call for a
    // no-actual-regression cause. Normalize root ("/") to itself, otherwise
    // strip a single trailing "/" so `.../authorize-echo` and
    // `.../authorize-echo/` compare equal. The subdomain-injection guard
    // still holds because origin includes the host.
    const normalizePath = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
    if (parsed.origin !== expected.origin || normalizePath(parsed.pathname) !== normalizePath(expected.pathname)) {
      throw new Error(
        `authorize 302 Location does not match the probe redirect URI origin+path (session invalidated, trusted client missing, or redirect regression): ${redactCodeAndState(location).slice(0, 200)}`
      );
    }
    const returnedCode = parsed.searchParams.get('code');
    if (!returnedCode) {
      // Wrap in `redactCodeAndState` to match sibling error branches. A
      // fragment-form Location like
      //   https://canary.wxyc.org/authorize-echo#code=REAL-CODE&state=X
      // slips past the origin+pathname compare (fragments live in the URL
      // hash, not the pathname) and `searchParams.get('code')` returns null
      // (fragments aren't parsed as query). Without redaction, the raw
      // fragment lands in the alert — direct violation of the docstring
      // "never logs the code" promise.
      throw new Error(
        `authorize 302 Location has no code query param (better-auth issued a bare redirect instead of a code): ${redactCodeAndState(location).slice(0, 200)}`
      );
    }
    const returnedState = parsed.searchParams.get('state');
    if (returnedState !== state) {
      // CSRF barrier: the server MUST echo the state we sent. If it echoes
      // something else — attacker fix, cross-tab pollution, better-auth
      // regression — pages. We can't log the returned state either (it
      // could carry canary-private info in a future rev); log only that
      // it mismatched.
      throw new Error('authorize 302 Location state does not match the state the check sent');
    }
    // Success: don't publish `EnrichmentLagSeconds`-style metrics — this
    // check's cost signal is `CheckLatency` (already emitted per-check by
    // the runner), and there's no domain-meaningful duration to surface.
  },
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
 * Parse a `Retry-After` header in seconds form (the date form is rare on
 * better-auth and not handled). Returns milliseconds, or undefined when
 * the header is missing/unparseable. Negative or non-finite values are
 * treated as missing.
 */
function parseRetryAfterMs(result: FetchResult): number | undefined {
  const raw = result.headers?.['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
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
// `userId` is best-effort: a missing user.id only fails the write canary
// (which throws its own preflight error when `ctx.djUserId` is undefined).
// Read-only DJ-auth checks tolerate the absence so a better-auth response-
// shape rev doesn't cascade into four false-positive failures.
//
// `sessionToken` is the raw better-auth session token returned from
// `/sign-in/email` (pre-JWT-exchange). The OIDC authorize probe uses it as
// an `Authorization: Bearer ...` header on `/oauth2/authorize` because
// better-auth's `bearer` plugin translates it into the session cookie the
// authorize endpoint reads via `getSessionFromCtx`. Distinct from `jwt`:
// the JWT is what Backend-Service routes accept via `requirePermissions`,
// but `/oauth2/authorize` needs the SESSION, not the JWT (a JWT from
// `/token` fails on authorize — different token audience). Undefined only
// when sign-in itself failed; in that case DJ-auth checks are already
// downgraded to `fail` at the auth-precondition layer.
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
    const delayMs = Math.min(parseRetryAfterMs(signIn) ?? 2000, 5000);
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
