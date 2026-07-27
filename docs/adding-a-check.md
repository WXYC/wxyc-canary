# Adding a check

1. Define a new `Check` in `src/checks.ts`. Its `run` function should throw on failure with a message that's safe to alert on (no secrets, short enough to read in PagerDuty).
2. Add a regression test in `test/handler.test.ts` that mocks the upstream response and asserts the new check is `pass` or `fail` accordingly.
3. `npm run typecheck && npm test`.
4. Open a PR. CI runs the same checks before deploy.

## Paging tier

A new check **pages on-call by default** — it joins the `UserFacingCheckFailure` aggregate behind the `wxyc-canary-check-failure` alarm. That's the fail-safe: a DJ-facing surface is the common case, so you have to opt out, not opt in.

Only opt out if the check probes infra/CI rather than a DJ-on-air surface — set `pagesOncall: false` on the check definition. Its failure then routes to the low-urgency `InfraCheckFailure` aggregate / `wxyc-canary-infra-degraded` alarm instead, which is console-only unless `InfraAlertEmail` is subscribed. Today `gha-runner-online` and `semantic-index-freshness` are opted out (the latter because a stale graph is degradation rather than an outage). `semantic-index-search` was opted out during its nightly-blip window but is back on the page now that semantic-index#347 ended the in-process OOM-restart (wxyc-canary#50). **`pagesOncall` is independent of `suites`** — leaving a check out of the `smoke` suite (CLI-unreachable) does NOT demote it from paging; `dj-rotation` and `dj-rotation-picker` are both untagged yet page.

Demoting a check to the infra tier reduces paging coverage of whatever it probes — file a tracked follow-up for the underlying flakiness rather than letting the demotion swallow it silently. The classification-pin test in `test/checks.test.ts` will fail until you update its expected opt-out set, which is the intended speed bump.

## Tests cover

- All anonymous checks pass when upstreams behave; DJ-auth checks skip without creds.
- Each of the three 2026-04-30 incident shapes produces a `fail` outcome on the right check (catalog-search 503, semantic-index missing `results` envelope, LML proxy 504).
- `semantic-index-freshness` (semantic-index#348 / wxyc-canary#53) fails on a stale graph (`graph_db_age_seconds` > 36 h) and on a sub-floor `artist_count` (< 100k), passes when fresh + above-floor (emitting `GraphDbAgeSeconds`), and — because `graph_db_age_seconds` is not yet live in prod `/health` — passes on the pre-#348 shape (`artist_count` only) without fabricating an age failure. Tier routing (infra, non-paging) is pinned in the `publishMetrics — tier split` block.
- `lml-discogs-breaker-shed` (wxyc-canary#79, volume-gated by wxyc-canary#84) always passes — `open`/`half-open`/`closed`/missing-field/non-200/network-error all reach `status: 'pass'` — and instead pins the `DiscogsBreakerShedding` metric value for each `discogs_breaker_state` reading: `open` → 1, `half-open` → 1, `closed` → 0, `null`/missing/unparseable/non-200 → 0 (indeterminate abstain, not a page-worthy verdict). It also pins `DiscogsLiveRequestsTotal`: emitted verbatim (including a genuine `0`) whenever `discogs_live_requests_total` in the `/health` body is a `number`, and omitted entirely (no key on `outcome.metrics`) on every indeterminate branch — network error, non-200, or missing/non-string `discogs_breaker_state`.
- One failing check does not short-circuit the others.
- Auth sign-in errors propagate as fail (not skip) on every DJ-auth check.
- Sign-in 429 retries once (and only on 429) and recovers when the second attempt succeeds; both attempts failing or any non-429 fail the precondition without retrying.

## Metric-carries-the-signal: an alternate design when `fail` is the wrong verb

Most checks throw on failure and let the runner's `CheckFailure` / `UserFacingCheckFailure` machinery carry the page. `lml-discogs-breaker-shed` (wxyc-canary#79) is the first check that deliberately does NOT: it always returns `pass`, and the thing worth paging on — the LML Discogs-breaker shedding lookup traffic — is carried entirely by a custom `{ metrics: {...} }` value (`DiscogsBreakerShedding`, 0 or 1) with its own dedicated `template.yaml` alarm (3-of-3 evaluations, not the shared page alarm's 2-of-3).

Reach for this pattern when a single observation is expected to flap on its own (a breaker legitimately trips for a window or two under real load) and the page-worthy signal is _sustained_ state, not a one-tick verdict — routing that through `CheckFailure` would either double-debounce against the shared aggregate's own window or force every other check's alarm to inherit a bespoke evaluation count it doesn't need. A dedicated metric + dedicated alarm keeps the sustained-detection logic out of the (stateless, per-tick) check body entirely.

wxyc-canary#84 extends the pattern one step further: when the Lambda is stateless across ticks and the real signal is a _delta_ (here, "is a monotonic counter advancing?"), don't try to smuggle cross-tick state through the check — the check's only job is to emit the raw current value (`DiscogsLiveRequestsTotal`) each tick, and the `DIFF()` that turns two raw values into a delta lives in the `template.yaml` alarm's metric-math expression, not in `src/checks.ts`. If you find yourself reaching for a module-level variable or an external store to remember "what was this last tick," that's the tell you're solving the problem in the wrong layer.

## When "I can't tell" should read as 0, not as a failure — and when it should read as nothing at all

`lml-discogs-breaker-shed` fixes an abstain value for `DiscogsBreakerShedding`: a network error, non-200, or unparseable/missing field all reads as `DiscogsBreakerShedding: 0` — the same abstain-on-indeterminate posture `lml-auth` and `semantic-index-freshness` use for an unreachable dependency, just expressed as a metric value instead of a `skipped` outcome (a metric-carrying check has no "skip the whole check" option — it always runs to completion and always reports a number). Don't invent a third value or omit the metric on indeterminate — a missing datapoint reads as "no data" on the dashboard, not as "confirmed not shedding," and the alarm's `TreatMissingData: notBreaching` already covers true absence (e.g. a deploy where the check hasn't run yet).

`DiscogsLiveRequestsTotal` (wxyc-canary#84) deliberately breaks that rule, and the reason is the alarm reads it through `DIFF()`, not `Maximum`. A gauge like `DiscogsBreakerShedding` has no "wrong" fabricated value — `0` is a legitimate, meaningful reading (not shedding). A monotonic counter does: fabricating `0` on an indeterminate `/health` read, then later emitting the real (much larger) value once LML answers again, would make `DIFF()` see a huge fake jump and misread "LML just came back" as "traffic just spiked." So `DiscogsLiveRequestsTotal` omits the metric key entirely on every indeterminate branch — a genuine `0` (LML reachable, Discogs unconfigured or truly idle) is still emitted, since that _is_ a real reading; only "I couldn't read this" abstains by omission, not by value. When you add a metric whose alarm uses `DIFF`/`RATE` rather than `Maximum`/`Sum`, default to omit-on-indeterminate, not fabricate-0 — ask whether `0` in your metric's domain means something real before reusing the gauge convention above.
