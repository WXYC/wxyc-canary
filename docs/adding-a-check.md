# Adding a check

1. Define a new `Check` in `src/checks.ts`. Its `run` function should throw on failure with a message that's safe to alert on (no secrets, short enough to read in PagerDuty).
2. Add a regression test in `test/handler.test.ts` that mocks the upstream response and asserts the new check is `pass` or `fail` accordingly.
3. `npm run typecheck && npm test`.
4. Open a PR. CI runs the same checks before deploy.

## Paging tier

A new check **pages on-call by default** — it joins the `UserFacingCheckFailure` aggregate behind the `wxyc-canary-check-failure` alarm. That's the fail-safe: a DJ-facing surface is the common case, so you have to opt out, not opt in.

Only opt out if the check probes infra/CI rather than a DJ-on-air surface — set `pagesOncall: false` on the check definition. Its failure then routes to the low-urgency `InfraCheckFailure` aggregate / `wxyc-canary-infra-degraded` alarm instead, which is console-only unless `InfraAlertEmail` is subscribed. Today only `gha-runner-online` and `semantic-index-search` are opted out. **`pagesOncall` is independent of `suites`** — leaving a check out of the `smoke` suite (CLI-unreachable) does NOT demote it from paging; `dj-rotation` and `dj-rotation-picker` are both untagged yet page.

Demoting a check to the infra tier reduces paging coverage of whatever it probes — file a tracked follow-up for the underlying flakiness rather than letting the demotion swallow it silently. The classification-pin test in `test/checks.test.ts` will fail until you update its expected opt-out set, which is the intended speed bump.

## Tests cover

- All anonymous checks pass when upstreams behave; DJ-auth checks skip without creds.
- Each of the three 2026-04-30 incident shapes produces a `fail` outcome on the right check (catalog-search 503, semantic-index missing `results` envelope, LML proxy 504).
- One failing check does not short-circuit the others.
- Auth sign-in errors propagate as fail (not skip) on every DJ-auth check.
- Sign-in 429 retries once (and only on 429) and recovers when the second attempt succeeds; both attempts failing or any non-429 fail the precondition without retrying.
