# wxyc-canary

Synthetic-DJ canary on AWS Lambda. Probes the WXYC user-facing API every five minutes and emits CloudWatch metrics + alarms. Built after the 2026-04-30 triple-incident (catalog-search 503, flowsheet POST 500, iOS decoder drift) to close the gap where production failures were detected by users rather than monitors.

## Code layout

| File                   | Purpose                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handler.ts`       | Lambda entry. Loads config, resolves DJ credentials (env or Secrets Manager), runs all checks in parallel, publishes per-check metrics to CloudWatch, throws if any check failed (so the Lambda Errors metric also fires). |
| `src/checks.ts`        | The check definitions and the `signInDj` helper. One exported `checks` array. Adding a new check = one entry.                                                                                                              |
| `src/client.ts`        | HTTP client wrapping `fetch` with a per-request `AbortController` timeout. Deliberately no retry on the surfaces being measured (a flaky retry hides brownouts).                                                           |
| `src/types.ts`         | Codable shapes for `Check`, `CheckOutcome`, `CanaryConfig`.                                                                                                                                                                |
| `template.yaml`        | SAM (CloudFormation) — Lambda + EventBridge schedule + SNS alert topic + two CloudWatch alarms + a log group.                                                                                                              |
| `test/handler.test.ts` | Vitest. Mocks global `fetch` and exercises the runner end-to-end. Includes regression cases for each 2026-04-30 incident shape.                                                                                            |

## Conventions

- Each check has a stable kebab-case `name` that lands in CloudWatch as a `Check` dimension. Renaming breaks pinned dashboards — pick well first time.
- Checks fail by **throwing**. The runner converts the throw into a `CheckOutcome` with `status: 'fail'` and the message. One throw never short-circuits the others (parallel `Promise.all` of independent try-catches).
- `requiresAuth: true` checks downgrade to `skipped` (separate metric from `fail`) when no DJ credentials are configured. The alarm only fires on `fail`, so an operator who hasn't provisioned the DJ test account gets a noisy console but not a phone call.
- Two credential paths: `CANARY_DJ_EMAIL` + `CANARY_DJ_PASSWORD` env vars (local + tests) or `CANARY_DJ_SECRET_ARN` pointing at a Secrets Manager secret with `{"email":"...","password":"..."}` (prod).
- Retry policy: the canary does **not** retry the surfaces it measures. The lone carve-out is `signInDj` retrying once on 429 only — auth is a precondition shared by 4 of 6 checks, so a single 429 there cascades into 4 simultaneous fail outcomes plus a Lambda Errors alarm. The retry honors `Retry-After` (seconds form), capped at 5s to fit the Lambda budget. Token exchange is not retried.

## Adding a check

1. Define a new `Check` in `src/checks.ts`. Its `run` function should throw on failure with a message that's safe to alert on (no secrets, short enough to read in PagerDuty).
2. Add a regression test in `test/handler.test.ts` that mocks the upstream response and asserts the new check is `pass` or `fail` accordingly.
3. `npm run typecheck && npm test`.
4. Open a PR. CI runs the same checks before deploy.

## Tests cover

- All anonymous checks pass when upstreams behave; DJ-auth checks skip without creds.
- Each of the three 2026-04-30 incident shapes produces a `fail` outcome on the right check (catalog-search 503, semantic-index missing `results` envelope, LML proxy 504).
- One failing check does not short-circuit the others.
- Auth sign-in errors propagate as fail (not skip) on every DJ-auth check.
- Sign-in 429 retries once (and only on 429) and recovers when the second attempt succeeds; both attempts failing or any non-429 fail the precondition without retrying.

## What this is not

- Not a load test. One synthetic call per check per five minutes.
- Not an iOS test. The semantic-index check confirms the server's contract, not that iOS decodes it.
- Not a write canary in v0. v1 will exercise start-show / log-track / end-show with a cleanup story so canary writes don't pollute the flowsheet.

## Related

- Org-level overview: `/Users/jake/Developer/WXYC/CLAUDE.md`
- Backend-Service repo CLAUDE.md describes the API this canary exercises and the auth flow.
- Run README.md for the operator runbook (deploy commands, alarm response, etc).
