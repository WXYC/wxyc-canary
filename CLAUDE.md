# wxyc-canary

Synthetic-DJ canary on AWS Lambda. Probes the WXYC user-facing API every five minutes and emits CloudWatch metrics + alarms. Built after the 2026-04-30 triple-incident (catalog-search 503, flowsheet POST 500, iOS decoder drift) to close the gap where production failures were detected by users rather than monitors.

## Topic guides

CLAUDE.md is a router for the always-loaded reference card. Topic depth lives in `docs/`:

- **[`docs/code-layout.md`](docs/code-layout.md)** — File-by-file purpose table: handler, checks, enrichment write-canary, client, types, github-issues reporter, SAM template, vitest suites.
- **[`docs/adding-a-check.md`](docs/adding-a-check.md)** — Procedure for adding a new check (define, test, typecheck, PR) plus the regression-test catalog the suite already pins.
- **[`docs/scope.md`](docs/scope.md)** — What this canary is _not_ (not a load test, not an iOS test) and the v1 write-canary opt-in invariants.

Read the relevant topic doc before doing work in that area.

## Conventions

- Each check has a stable kebab-case `name` that lands in CloudWatch as a `Check` dimension. Renaming breaks pinned dashboards — pick well first time.
- `CheckFailure` is published twice per check: once with the `Check` dimension (for dashboards and per-surface drill-down) and once dimensionless (the series the `wxyc-canary-check-failure` alarm queries). The alarm uses the plain `Namespace`/`MetricName` form with `Statistic: Maximum` so any failing check in a 5-minute window trips the alarm. CloudWatch alarms reject the `SUM(SEARCH(...))` expression that would otherwise let one alarm watch every dimension value (commits b7312c3 / 299deb5 / issue #13), so emit-twice is the supported equivalent. `CheckSkipped` and `CheckLatency` are emitted dimensioned-only — they're for dashboards, not alarming. The `template.yaml ↔ publishMetrics contract` test in `test/handler.test.ts` parses `template.yaml`, harvests the metrics the handler actually publishes, and asserts every `Namespace: WXYC/Canary` alarm targets a `(MetricName, Dimensions-shape)` the code emits — adding a new canary alarm therefore requires either matching the emission or adding one. External-namespace alarms (`AWS/Lambda`, `WXYC/BackendService`) are skipped.
- Custom per-check metrics (e.g. `EnrichmentLagSeconds`) follow the same emit-twice pattern. A check declares them by returning `{ metrics: { ... } }` from its `run`; the runner stores them on the outcome; `publishMetrics` emits each entry once dimensioned (`Check=<name>`) and once dimensionless. Unit is inferred from the metric-name suffix: `*Seconds` → `Seconds`, `*Milliseconds` → `Milliseconds`, else `Count`. Keep names consistent with this convention — a metric named `Latency` would silently publish as `Count` and break any unit-aware dashboard.
- Checks fail by **throwing**. The runner converts the throw into a `CheckOutcome` with `status: 'fail'` and the message. One throw never short-circuits the others (parallel `Promise.all` of independent try-catches).
- `requiresAuth: true` checks downgrade to `skipped` (separate metric from `fail`) when no DJ credentials are configured. The alarm only fires on `fail`, so an operator who hasn't provisioned the DJ test account gets a noisy console but not a phone call.
- `writes: true` checks (the v1 write canary) downgrade to `skipped` when `CANARY_ENABLE_WRITE_PROBE=true` is unset. Gate is intentional: a fresh deploy stays read-only until the operator provisions the DJ test account and reviews cleanup-on-failure behaviour. A check can also return `{ skipped: true, skipReason }` to record skip from inside its `run` (used by the enrichment check when another DJ is on-air — the canary deliberately does not insert sentinel rows into a live show).
- Two credential paths: `CANARY_DJ_EMAIL` + `CANARY_DJ_PASSWORD` env vars (local + tests) or `CANARY_DJ_SECRET_ARN` pointing at a Secrets Manager secret with `{"email":"...","password":"..."}` (prod).
- Retry policy: the canary does **not** retry the surfaces it measures. The lone carve-out is `signInDj` retrying once on 429 only — auth is a precondition shared by 4 of 6 checks, so a single 429 there cascades into 4 simultaneous fail outcomes plus a Lambda Errors alarm. The retry honors `Retry-After` (seconds form), capped at 5s to fit the Lambda budget. Token exchange is not retried.
- The GitHub-issue reporter is **best-effort and non-fatal**. The handler wraps `reportOutcomesToGitHub` in a try/catch (parallel to `publishMetrics`) — a GitHub outage logs and continues so the canary's primary signal (the dimensionless `CheckFailure` series + the Lambda Errors alarm) is never masked by a reporter-induced exception. The SNS topic and `wxyc-canary-lambda-errors` alarm stay armed as the safety net for when the Lambda dies before the reporter runs. Dedup is by label (`canary:check:{name}`), not title — titles drift as error messages change; labels are durable. A `pass` after a `fail` closes the open issue with a recovery comment; a `pass` with no open issue is a no-op. `skipped` outcomes are always no-ops (operator gap, not regression).

## Related

- Org-level overview: `/Users/jake/Developer/WXYC/CLAUDE.md`
- Backend-Service repo CLAUDE.md describes the API this canary exercises and the auth flow.
- Run README.md for the operator runbook (deploy commands, alarm response, etc).
