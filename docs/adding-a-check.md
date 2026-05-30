# Adding a check

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
