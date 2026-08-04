# wxyc-canary

Synthetic-DJ canary that exercises the WXYC user-facing API surface every five minutes from AWS Lambda. Catches outages on the paths a DJ actually touches before a DJ on-air does.

The canary exists because three production incidents on 2026-04-30 (catalog-search 503, flowsheet POST 500, semantic-index decoder drift) were all detected by users hitting them rather than by any monitor. Each one would have surfaced as a CheckFailure metric on this canary within five minutes of going wrong.

## What it checks

| Check                      | Endpoint                                                                                                                                        | Auth             | What it would have caught                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend-healthcheck`      | `GET /healthcheck`                                                                                                                              | none             | Process-level outage on Backend-Service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `proxy-library-search`     | `GET /proxy/library/search?artist=Stereolab&limit=5`                                                                                            | anonymous device | LML degradation, BS proxy regressions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `semantic-index-search`    | `GET https://explore.wxyc.org/graph/artists/search?q=Stereolab&limit=1`                                                                         | none             | semantic-index 5xx; missing `results` envelope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `semantic-index-freshness` | `GET https://explore.wxyc.org/health`                                                                                                           | none             | The silent nightly-sync failure (semantic-index#329): an OOM kills the rebuild before the atomic swap, so the serving host keeps answering from a stale (or empty) graph and nothing reaches Sentry. Fails when `graph_db_age_seconds` > 36 h (a missed/failed 09:00 UTC sync) or `artist_count` < 100,000 (empty/truncated build). Infra tier (does not page).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dj-library-search`        | `GET /library/?artist_name=Stereolab&n=5`                                                                                                       | DJ JWT           | The 2026-04-30 catalog-search 503 incident, exactly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dj-flowsheet-read`        | `GET /flowsheet?n=5`                                                                                                                            | DJ JWT           | Flowsheet read-side regressions (targets v1; flips to `/v2/flowsheet` once PR #182 ships)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dj-rotation`              | `GET /library/rotation`                                                                                                                         | DJ JWT           | Rotation endpoint 5xx, fully empty rotation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dj-rotation-picker`       | `GET /library/rotation/{id}/tracks` (id discovered from list)                                                                                   | DJ JWT           | The BS#994 / BS#1030 cascade-to-502 class; LML-cascade timeouts on the picker that previously surfaced via on-air Slack                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lml-auth`                 | `POST /api/v1/lookup` directly to LML — twice, once with `LML_API_KEY` (assert 2xx) and once with a synthetic known-bad bearer (assert 401/403) | LML bearer       | BS#1094 `LML_API_KEY` rotation drift (good-bearer 401/403); LML auth disabled regression (known-bad bearer 200, i.e. `LML_REQUIRE_AUTH=false` flip or rollback). **Pages only on those two definitive auth verdicts.** A timeout / 5xx / 429 leaves the auth state indeterminate → `skipped`, not `fail` (LML availability is covered by `proxy-library-search` + dj-\* checks; the cold `/api/v1/lookup` can exceed the 8s budget). Distinct error messages route the operator to the right remediation.                                                                                                                                                                                                                                                                                                                                                                                        |
| `lml-discogs-breaker-shed` | `GET /health` on LML — reads `discogs_breaker_state` + `discogs_live_requests_total`                                                            | none             | LML's Discogs-saturation breaker shedding lookup traffic (library-metadata-lookup#939). **This check's own status always `pass`es** — the shed signal is carried entirely by the `DiscogsBreakerShedding` metric (0/1) and a dedicated 3-of-3 **volume-gated** alarm (`wxyc-canary-lml-discogs-breaker-shed`, wxyc-canary#84), not by `CheckFailure`. `open`/`half-open` → 1; `closed`/missing/non-200/network-error → 0 (abstain on indeterminate). Also emits `DiscogsLiveRequestsTotal` (library-metadata-lookup#940's monotonic live-lookup counter) whenever `/health` returns it as a non-negative integer, omitted entirely on the same indeterminate branches (and on a contract-violating negative/fractional value). The alarm pages only when shedding **and** that counter is advancing — see the runbook entry below for the idle-tail mechanics, now handled rather than accepted. |
| `lml-protected-search`     | `GET /api/v1/library/search?artist=Stereolab&limit=5` directly to LML                                                                           | LML bearer       | BS#1819: proves LML's protected local-search path (library-metadata-lookup#929) stays healthy in isolation from BS. Direct to LML, not through Backend-Service, because BS#1826 PR 2 made `/proxy/library/search` degrade to `{results: [], total: 0}` on any LML error instead of surfacing it — `proxy-library-search` alone can no longer detect an LML-side local-search regression. 3 s timeout (matching BS's own protected-search caller budget). Fails on non-2xx, a malformed body, or zero hits.                                                                                                                                                                                                                                                                                                                                                                                       |
| `lml-enrichment-lookup`    | `POST /api/v1/lookup` directly to LML with a canonical WXYC fixture                                                                             | LML bearer       | BS#1819: the Discogs-dependent enrichment lane, kept **distinct from `lml-protected-search`** so an alarm can tell local-search degradation apart from enrichment degradation. A network error, non-2xx, or an unexplained zero-result miss is a hard fail (pages via the shared alarm). A 2xx with `degraded: true` or `timeout: true` (library-metadata-lookup#930's `LookupResponse` fields) still `pass`es — the signal is carried by the `LookupDegraded` metric (0/1) and a dedicated 3-of-3 alarm (`wxyc-canary-lml-enrichment-degraded`), mirroring `lml-discogs-breaker-shed`'s pattern: a single degraded tick is expected Discogs-side noise, sustained degradation is page-worthy.                                                                                                                                                                                                   |
| `gha-runner-online`        | `GET /orgs/{org}/actions/runners/{id}`                                                                                                          | GH PAT           | Staging-gate runner host wedge / systemd unit death / network egress break — the low-urgency signal (infra tier, does not page) that the EC2-hosted runner (WXYC/wiki#80 phase 1) needs replacing or rebooting. Distinct messages route offline vs 404 (runner replaced) vs 401 (PAT rotation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `enrichment-quality`       | insert sentinel → poll for enrichment → delete                                                                                                  | DJ JWT (write)   | The 2026-05-13 LML cascade regression (null-metadata on inserts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `oidc-authorize`           | `GET /auth/oauth2/authorize?response_type=code&client_id=wxyc-canary&…` with PKCE, `redirect: 'manual'`                                         | DJ session       | The BS#1571 `oauthConsent` schema-drift 500 that stayed silent for months until the flowsheet-digitization verifier tripped it in production. Uses a dedicated `wxyc-canary` public trusted client (BS#1576) so no OIDC secret lives in the canary env; the probe reads the 302 `Location` without following the redirect and asserts `code=<non-empty>` + matching `state`. Fails on non-302, missing/mismatched state, missing code, login-page bounce, or a 5xx (BS#1571 replay class).                                                                                                                                                                                                                                                                                                                                                                                                       |

DJ-auth checks downgrade to `skipped` (a distinct CloudWatch metric, not `failed`) when no DJ credentials are configured, so the alarm doesn't fire on operator-caused gaps. The `lml-auth` check follows the same shape: it skips when no `LML_API_KEY` is configured — as do `lml-protected-search` and `lml-enrichment-lookup`, which share the same bearer. The `gha-runner-online` check skips when no GitHub PAT or runner id is configured. The `enrichment-quality` write canary additionally requires `CANARY_ENABLE_WRITE_PROBE=true` and skips when another DJ is on-air — the canary deliberately doesn't inject sentinel rows into a real DJ's flowsheet.

**Paging tier (wxyc-canary#48).** Not every failing check should page on-call. Thirteen of these checks are user-facing and **page** via `wxyc-canary-check-failure`: `backend-healthcheck`, `proxy-library-search`, `semantic-index-search`, `dj-library-search`, `dj-flowsheet-read`, `dj-rotation`, `dj-rotation-picker`, `lml-auth`, `lml-protected-search`, `lml-enrichment-lookup`, `lml-discogs-breaker-shed`, `enrichment-quality` (which pages only when the write probe is enabled and its sentinel insert→enrich→cleanup cycle fails — including the null-metadata / enrichment-timeout shape it exists to catch), and `oidc-authorize` (login is a DJ-on-air surface — every OIDC client breaks together when this path breaks). Two are infra/CI probes and **don't page** — they route to the low-urgency `wxyc-canary-infra-degraded` alarm instead: `gha-runner-online` (the self-hosted CI runner is an operator concern, not a DJ-on-air path) and `semantic-index-freshness` (the silent stale-graph backstop — a stale graph is degradation, not an outage, and it fired daily by design during the semantic-index#347 build window). The tier is set by the explicit `pagesOncall` field on each check (default `true`), **not** by suite membership — `dj-rotation` / `dj-rotation-picker` are untagged for CLI reasons but still page. `lml-discogs-breaker-shed` is `pagesOncall: true` in the classification-pin sense (it's user-facing, not infra), but its own check status never actually fails — the breaker-shed signal pages through a separate dedicated alarm on the `DiscogsBreakerShedding` metric instead of through `UserFacingCheckFailure`; see "Alarm fires: `wxyc-canary-lml-discogs-breaker-shed`" below. `lml-enrichment-lookup` follows the same shape for its _soft_ degradation signal — see "Alarm fires: `wxyc-canary-lml-enrichment-degraded`" below — while its hard-failure branch pages through the ordinary `UserFacingCheckFailure` route like any other check. **Restored:** `semantic-index-search` was demoted to infra because it flapped every night ~09:00 UTC on semantic-index's in-process sync/rebuild contention; [semantic-index#347](https://github.com/WXYC/semantic-index/issues/347) moved the rebuild off-host (the in-process daemon that OOM-restarted uvicorn is disabled), the surface has been reliably green since, and the check is back on the page per [wxyc-canary#50](https://github.com/WXYC/wxyc-canary/issues/50). **Promotion path:** `semantic-index-freshness` may follow `semantic-index-search` to `pagesOncall: true` once a stale graph is judged page-worthy and freshness has held for a sustained window — a separate decision, not gated on #50. **Accepted gap:** the infra tier is **console-only until `InfraAlertEmail` is set** — leaving it empty means `wxyc-canary-infra-degraded` transitions in CloudWatch but notifies nobody.

## Architecture

```
EventBridge Scheduler (rate(5 minutes))
        │
        ▼
   Lambda function ──► CloudWatch metrics (WXYC/Canary namespace)
        │                    │
        │                    ▼
        │              CloudWatch Alarm ──► SNS topic ──► Slack / email
        ▼
  Backend-Service / LML / semantic-index (production)
```

- One Lambda invocation per schedule. All checks run in parallel; one failure does not short-circuit the others.
- Per-check metrics: `CheckFailure`, `CheckSkipped`, `CheckLatency`, all dimensioned on `Check=<name>`. Plus `EnrichmentLagSeconds` from the v1 write canary, `GraphDbAgeSeconds` from `semantic-index-freshness`, `DiscogsBreakerShedding` + `DiscogsLiveRequestsTotal` from `lml-discogs-breaker-shed`, and `LookupDegraded` from `lml-enrichment-lookup` (all dimensioned + dimensionless; `GraphDbAgeSeconds` is dashboard-trend-only — no alarm reads it, the freshness failure is carried by the `InfraCheckFailure` aggregate; `DiscogsBreakerShedding` + `DiscogsLiveRequestsTotal` feed the dedicated volume-gated alarm below — `DiscogsLiveRequestsTotal`'s dimensioned copy is otherwise unused, an accepted wxyc-canary#78 cardinality cost since a per-metric dimensionless-only emission would require new machinery; `LookupDegraded` feeds `wxyc-canary-lml-enrichment-degraded` below). Two dimensionless-only aggregates route failures by paging tier: `UserFacingCheckFailure` and `InfraCheckFailure` (see "Paging tier" above).
- Seven alarms: `wxyc-canary-check-failure` (a **user-facing** check failed in 2 of last 3 evaluations → `AlertTopic`), `wxyc-canary-infra-degraded` (an **infra/CI** probe failed, same 2-of-3 window → low-urgency `InfraAlertTopic`), `wxyc-canary-enrichment-lag` (sentinel row took > 30 s to enrich for 3 consecutive evaluations), `wxyc-canary-lml-discogs-breaker-shed` (LML's Discogs breaker shed lookup traffic **and** live lookup volume was advancing, for 3 **consecutive** evaluations — 3-of-3, not 2-of-3, since a brief real trip is expected → `AlertTopic`; a metric-math alarm as of wxyc-canary#84, this repo's first — see the runbook entry), `wxyc-canary-lml-enrichment-degraded` (`lml-enrichment-lookup`'s `LookupDegraded` series held `>= 1` for 3 consecutive evaluations — the BS#1819 enrichment-lane degradation signal, distinct from local-search failures → `AlertTopic`), `wxyc-canary-lambda-errors` (Lambda crashed before publishing metrics), and `wxyc-canary-mutation-4xx-surge` (a sustained surge of 4xx on Backend-Service mutation routes — a `WXYC/BackendService` metric, not a canary check → `AlertTopic`).

## Local development

```bash
npm install
npm test          # vitest, fully mocked
npm run typecheck
```

Run the handler against a real environment:

```bash
export CANARY_BACKEND_URL=https://api.wxyc.org
export CANARY_AUTH_URL=https://api.wxyc.org/auth
export CANARY_SEMANTIC_INDEX_URL=https://explore.wxyc.org
export CANARY_PUBLISH_METRICS=false
# Optional, exercises DJ-auth checks:
export CANARY_DJ_EMAIL=canary@wxyc.org
export CANARY_DJ_PASSWORD=...
npm run local
```

## CLI for staging-gate consumers

The same check code that runs in the Lambda is also exposed as a `wxyc-canary` CLI for the [WXYC/wiki#80](https://github.com/WXYC/wiki/issues/80) staging-gate workflows (wxyc-shared `bs-lml-gate.yml`, dj-site `staging-gate.yml`). The CLI runs probes against arbitrary BS/LML URLs — staging, preview, prod — and reports exit codes a GHA workflow can branch on.

### Invocation

```bash
wxyc-canary check \
  --base-url=https://bs-staging.wxyc.org \
  --auth-url=https://bs-staging.wxyc.org/auth \
  --lml-url=https://library-metadata-lookup-staging.up.railway.app \
  --suite=smoke
```

Credentials come from environment variables only (flags would leak into shell history and CI logs):

| Env var              | Purpose                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CANARY_DJ_EMAIL`    | DJ login email. Pairs with `CANARY_DJ_PASSWORD`; when the selected suite includes a DJ-auth check, both must be set together or both unset (XOR is rejected as exit 2). Whitespace-only values are treated as unset. When both unset, DJ-auth checks `skipped` (not fail). |
| `CANARY_DJ_PASSWORD` | DJ login password. See above.                                                                                                                                                                                                                                              |
| `CANARY_LML_API_KEY` | LML bearer for the `lml-auth` check. Without it, the check `skipped`.                                                                                                                                                                                                      |
| `CANARY_ORIGIN_URL`  | Sent as `Origin:` on better-auth calls. Must match a `BETTER_AUTH_TRUSTED_ORIGINS` value. Defaults to `https://dj.wxyc.org`.                                                                                                                                               |

`*_SECRET_ARN` and `*_SSM_PARAM` env vars used by the Lambda are **not** read by the CLI. The CLI passes a sanitized env to `runCanary` so an operator with those vars exported in their shell cannot accidentally trigger AWS-SDK calls from a CLI invocation — verified by `test/cli-aws-isolation.test.ts`.

### Suites

| Suite   | Checks included                                                                                                       | Use case                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `smoke` | `backend-healthcheck`, `proxy-library-search`, `dj-library-search`, `dj-flowsheet-read`, `lml-auth`, `oidc-authorize` | BS+LML staging-gate, dj-site gate-vs-prod |

Lambda-only checks (`gha-runner-online`, `enrichment-quality`, `semantic-index-search`, `semantic-index-freshness`, `dj-rotation`, `dj-rotation-picker`, `lml-discogs-breaker-shed`) are unreachable from the CLI by design — they're either prod-only operator concerns, writes, or out-of-scope services. Add a new suite by extending the `Suite` union in `src/types.ts`, appending to `VALID_SUITES` in `src/checks.ts`, and tagging the relevant checks with `suites: [...]`.

### Output

Stdout is exactly one JSON line, parseable by `jq`. The outcome shape is projected to the documented fields below — fields like `metrics` that the Lambda may attach internally are **not** emitted by the CLI, even when a future check returns them:

```json
{
  "suite": "smoke",
  "passed": 4,
  "failed": 0,
  "skipped": 1,
  "outcomes": [
    { "name": "backend-healthcheck", "status": "pass", "latencyMs": 12 },
    { "name": "proxy-library-search", "status": "pass", "latencyMs": 45 },
    { "name": "dj-library-search", "status": "pass", "latencyMs": 67 },
    { "name": "dj-flowsheet-read", "status": "pass", "latencyMs": 22 },
    { "name": "lml-auth", "status": "skipped", "latencyMs": 0, "message": "no LML_API_KEY configured" }
  ]
}
```

`outcomes[i].message` is present only when `status !== 'pass'`. Control characters AND Unicode line separators (U+2028, U+2029, U+0085) in messages are stripped before they reach stderr to neutralize log-injection attempts via probed-endpoint response bodies. The same sanitizer is applied to the fatal-error path (any uncaught throw out of `runCli` runs through `sanitizeForLog` before being written to stderr) so a thrown Error whose message interpolates a server response body cannot bypass the defense.

Stderr is a human-readable summary headline plus a line for every non-pass outcome — readable from a GHA workflow log without piping stdout through `jq`.

### Exit codes

| Code | Meaning                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Every check returned `pass` or `skipped`.                                                                                                                                                        |
| `1`  | At least one check returned `fail`. Stdout JSON names the failing check(s); stderr lists them with messages.                                                                                     |
| `2`  | Invocation error (unknown subcommand, missing required flag, unknown flag, unknown suite). Distinct from `1` so the gate workflow can tell "your config is wrong" from "your service is broken". |

### Distribution (e2e-runner consumption)

The CLI is consumed by cloning the repo onto the e2e-runner host during bootstrap:

```bash
sudo mkdir -p /opt/wxyc-canary
sudo chown $USER /opt/wxyc-canary
git clone https://github.com/WXYC/wxyc-canary.git /opt/wxyc-canary
cd /opt/wxyc-canary
git checkout <pinned-sha>
npm ci
npm run build:cli
```

Workflows then invoke it as:

```bash
node /opt/wxyc-canary/dist/cli.js check --base-url=... --auth-url=... --lml-url=... --suite=smoke
```

Pinning to a SHA gives consumers an explicit upgrade lever — bump the SHA in the runner-bootstrap script to pick up a non-breaking change; a breaking change forces re-running the bootstrap. The full update procedure lives in the staging-gate runbook ([WXYC/wiki#81](https://github.com/WXYC/wiki/issues/81)).

### Side-effect contract

The CLI never instantiates the AWS SDK. It hard-codes `publishMetrics: false`, doesn't read any `*_SSM_PARAM` or `*_SECRET_ARN` env vars, and never reaches the GitHub-issue-mirroring code path. The Lambda's runner-liveness probe (`gha-runner-online`) and write canary (`enrichment-quality`) stay invisible to the CLI even when a future operator sets the corresponding env vars — they're not in any suite.

## Deploying

### One-time setup

1. Provision a DJ test account in prod auth — `canary@wxyc.org` with the `dj` role and nothing more. Use `POST /auth/admin/provision-user` with an admin session.
2. Store the credentials in AWS Secrets Manager:
   ```bash
   aws secretsmanager create-secret \
     --name wxyc-canary-dj-credentials \
     --secret-string '{"email":"canary@wxyc.org","password":"<long random string>"}'
   ```
3. Note the resulting secret ARN; you'll pass it as a parameter to the stack.
4. Decide where alerts go. The simplest path: subscribe an email to the SNS topic via the `AlertEmail` parameter. For Slack, deploy first, then attach a Lambda subscriber that POSTs to a Slack webhook (or use AWS Chatbot).

### First deploy

```bash
npm ci
npm run build
sam build
sam deploy --guided \
  --parameter-overrides \
    DjCredentialsSecretArn=arn:aws:secretsmanager:us-east-1:<account>:secret:wxyc-canary-dj-credentials-XXX \
    AlertEmail=ops@wxyc.org \
    EnableWriteProbe=false
```

Leave `EnableWriteProbe=false` for the first deploy. Once the DJ test account is provisioned, the `wxyc-canary-enrichment-lag` alarm is wired to the right SNS subscriber, and you've verified cleanup behaviour in a manual local run (`CANARY_ENABLE_WRITE_PROBE=true npm run local` against a non-prod environment), redeploy with `EnableWriteProbe=true` to turn the write canary on.

### Verifying the write canary in staging

The enrichment-quality check exists to catch the 2026-05-13 class of regression: silent latency-cliff in LML that leaves `youtube_music_url` null on inserts. To validate the alarm wiring before relying on it:

1. In staging, set LML's `discogs_max_concurrent=0` (or otherwise force enrichment failure).
2. Confirm `EnrichmentLagSeconds` climbs and the `wxyc-canary-enrichment-lag` alarm transitions to ALARM within 15 minutes (3 consecutive 5-minute breaches).
3. Revert the LML change. The alarm should return to OK within the next two evaluation periods.

The first invocation runs ~5 minutes after deploy. Confirm via:

```bash
aws logs tail /aws/lambda/wxyc-canary --follow
aws cloudwatch get-metric-statistics \
  --namespace WXYC/Canary --metric-name CheckFailure \
  --dimensions Name=Check,Value=backend-healthcheck \
  --statistics Sum --period 300 \
  --start-time $(date -u -v-1H '+%Y-%m-%dT%H:%M:%S') \
  --end-time $(date -u '+%Y-%m-%dT%H:%M:%S')
```

### GitHub-issue reporting (optional)

When you want canary failures to land as GitHub issues for morning triage (instead of, or in addition to, SNS email), wire a fine-scoped PAT through SSM Parameter Store and pass two stack parameters. The reporter is best-effort and non-fatal: a GitHub outage never masks the canary's primary signal (the `UserFacingCheckFailure` / `InfraCheckFailure` tier aggregates that back the alarms). SNS + the `wxyc-canary-lambda-errors` alarm stay armed as the fallback for when the Lambda itself dies before the reporter runs.

1. Create a GitHub fine-scoped PAT:
   - Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - **Resource owner**: `WXYC`. **Repository access**: only the issue target repo (e.g. `WXYC/wxyc-canary`).
   - **Permissions** → **Repository permissions** → **Issues**: Read and write.
   - No other scopes. Set a reasonable expiry and a calendar reminder to rotate.
2. Store it in SSM as a SecureString:
   ```bash
   aws ssm put-parameter \
     --name /wxyc-canary/github-token \
     --type SecureString \
     --value "$PAT" \
     --description "PAT for wxyc-canary to file/close issues. Rotate by overwriting with --overwrite."
   ```
3. Pass both stack parameters on deploy:
   ```bash
   sam deploy \
     --parameter-overrides \
       GitHubTokenSsmParamName=/wxyc-canary/github-token \
       GitHubIssuesRepo=WXYC/wxyc-canary \
       # ...other params
   ```

Behavior per outcome status:

| Outcome   | Reporter action                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fail`    | Open a new issue if none labeled `canary:check:{name}` is open; otherwise comment on the existing issue with the new error message. |
| `pass`    | If an open issue labeled `canary:check:{name}` exists, post a recovery comment and close it (`state_reason: completed`).            |
| `skipped` | No-op. Skipped means an operator-configuration gap (no DJ credentials, write probe disabled), not a regression.                     |

Dedup key is the `canary:check:{name}` label, not the title. Labels are durable across error-message changes; titles drift as the failure mode changes.

To turn off GitHub-issue reporting, redeploy with empty `GitHubTokenSsmParamName` (the conditional in `template.yaml` then removes the SSM IAM grant and env vars).

### Runner liveness probe (`gha-runner-online`)

The `gha-runner-online` check polls the WXYC org's self-hosted GitHub Actions runner that hosts the staging-gate E2E suites (WXYC/wiki#80 phase 1 — see wxyc-shared `scripts/e2e-runner/README.md` for the runner bootstrap + topology). It calls `GET /orgs/WXYC/actions/runners/{id}` every five minutes and fails when `status != "online"`. This check is infra-tier (`pagesOncall: false`), so its failures feed the low-urgency `wxyc-canary-infra-degraded` alarm — not the user-facing page. That alarm's 3 evaluations × 5 min, 2 datapoints-to-alarm window gives the spec's ≥10 minutes of sustained breach. A GitHub-side 5xx, a network error/timeout, or any rate-limit response (403-primary, 403-secondary, or a bare 429) abstains (`skipped`) rather than failing — "GitHub couldn't answer" is indeterminate for runner liveness, not a WXYC-actionable signal (wxyc-canary#86, extended to rate-limit by wxyc-canary#88). A genuinely-offline runner still returns HTTP 200 + `{"status":"offline"}` and still fails.

1. Create a GitHub fine-scoped PAT:
   - Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - **Resource owner**: `WXYC`. **Repository access**: doesn't matter — this is an org-scoped permission.
   - **Permissions** → **Organization permissions** → **Self-hosted runners**: Read.
   - No other scopes. Set a reasonable expiry and a calendar reminder to rotate.
2. Store it in SSM as a SecureString. Keep it under `/wxyc-canary/*` so it shares the rotation cadence and IAM grant pattern with the GitHub-issues reporter PAT:
   ```bash
   aws ssm put-parameter \
     --name /wxyc-canary/gha-runner-token \
     --type SecureString \
     --value "$PAT" \
     --description "PAT for wxyc-canary runner-liveness probe. Rotate by overwriting with --overwrite."
   ```
3. Discover the runner id (changes on re-registration):
   ```bash
   gh api /orgs/WXYC/actions/runners \
     --jq '.runners[] | select(.name=="wxyc-e2e-runner") | {id, status, labels: [.labels[].name]}'
   ```
4. Pass three stack parameters on the next deploy:
   ```bash
   sam deploy \
     --parameter-overrides \
       GhaRunnerTokenSsmParamName=/wxyc-canary/gha-runner-token \
       GhaRunnerOrg=WXYC \
       GhaRunnerId=<id from step 3> \
       # ...other params
   ```

When the runner is replaced (instance swap or re-registration), repeat step 3 and redeploy with the new `GhaRunnerId`. The check will fail with a 404-flavoured message until the parameter is re-set — that's intentional, since a stale `GhaRunnerId` is itself a real signal the operator should fix.

To turn the probe off, redeploy with an empty `GhaRunnerTokenSsmParamName` or `GhaRunnerId=0`. The conditional in `template.yaml` then strips the SSM IAM grant and the env vars; the check downgrades to `skipped` and the alarm stays quiet.

### CI deploys (GitHub OIDC)

`.github/workflows/deploy.yml` builds + deploys on push to `main`. It authenticates to the WXYC AWS account (`203767826763`) by assuming an IAM role via **GitHub OIDC — no long-lived AWS keys are stored in the repo**. The role's trust policy is pinned to `repo:WXYC/wxyc-canary:ref:refs/heads/main`, so only a push to `main` in this repo can assume it.

**One-time account bootstrap** (already applied to `203767826763`): deploy `bootstrap/deploy-role.yaml`, which creates the account-global GitHub OIDC provider and the least-privilege `wxyc-canary-deploy` role (scoped to `wxyc-canary*` resources + the SAM managed bucket):

```bash
aws cloudformation deploy \
  --template-file bootstrap/deploy-role.yaml \
  --stack-name wxyc-canary-deploy \
  --capabilities CAPABILITY_NAMED_IAM
```

Take the stack's `DeployRoleArn` output and set it as the `AWS_DEPLOY_ROLE_ARN` GitHub variable.

> **The OIDC provider is account-global (unique per URL) and this stack owns it. It now has a second consumer.** [`WXYC/discogs-etl`](https://github.com/WXYC/discogs-etl) adopted OIDC in this account on 2026-08-04 ([discogs-etl#353](https://github.com/WXYC/discogs-etl/issues/353)) and references the provider by ARN from its own `infra/bootstrap/deploy-role.yaml` rather than re-declaring it — a second `AWS::IAM::OIDCProvider` for the same URL fails with `EntityAlreadyExists`.
>
> Two consequences. **Deleting the `wxyc-canary-deploy` stack now breaks discogs-etl's CI deploy**, not just this repo's; the provider goes with it. And the "move the provider into its own shared stack" refactor below is no longer hypothetical work for a future repo — it is deferred work with a live cross-repo dependency. Doing it means updating discogs-etl's `OidcProviderArn` parameter in the same change.

When a third WXYC repo adopts OIDC, move the provider into its own shared stack and leave only per-repo roles in each repo's bootstrap.

Required GitHub variables:

- `AWS_DEPLOY_ROLE_ARN` — the `wxyc-canary-deploy` role ARN from the bootstrap stack. The workflow's `permissions: id-token: write` block (already present) lets the runner mint the OIDC token; `configure-aws-credentials` exchanges it for short-lived role credentials.
- `AWS_REGION` — `us-east-1`.
- `BACKEND_URL`, `AUTH_URL`, `SEMANTIC_INDEX_URL`, `LML_URL`, `OIDC_PROBE_REDIRECT_URI`, `ALERT_EMAIL`
- `INFRA_ALERT_EMAIL` — optional low-urgency recipient for `wxyc-canary-infra-degraded` (the infra/CI tier, wxyc-canary#48). Leave unset for console-only; set it to a filtered alias to get non-paging email. An empty value is an accepted gap, not a silent one.

Required GitHub secrets:

- `DJ_CREDENTIALS_SECRET_ARN` — ARN of the Secrets Manager secret holding the canary DJ login (from the one-time setup above).
- `LML_API_KEY_SECRET_ARN` — ARN of the Secrets Manager secret holding the shared LML bearer. **Copied, never rotated** — the same value backs BS + rom + tubafrenzy (Railway's one-secret-one-value convention).

Optional GitHub variables for the runner-liveness probe (when all three are set the next deploy enables `gha-runner-online`; leave unset to keep it skipped):

- `GHA_RUNNER_TOKEN_SSM_PARAM_NAME` — SSM SecureString path that the operator has populated, e.g. `/wxyc-canary/gha-runner-token`. Defaults empty → probe disabled.
- `GHA_RUNNER_ORG` — defaults to `WXYC`.
- `GHA_RUNNER_ID` — numeric runner id from `gh api /orgs/WXYC/actions/runners`. Defaults to `0` → probe disabled.

## Operating runbook

### Alarm fires: `wxyc-canary-check-failure`

This is the **user-facing-outage page** — a DJ-facing surface has been failing for ~10 minutes. (Infra/CI probes route to `wxyc-canary-infra-degraded` instead; see below.)

1. Open CloudWatch → Metrics → `WXYC/Canary` → `CheckFailure`, filtered to the `Check` dimension, to see which surface is broken. (The alarm itself reads the dimensionless `UserFacingCheckFailure` aggregate, which names the tier but not the specific check — the dimensioned `CheckFailure` is the drill-down.)
2. Tail the canary log: `aws logs tail /aws/lambda/wxyc-canary --since 30m`. Each invocation prints a JSON line with all check outcomes.
3. Reproduce the failing endpoint manually (the `description` column above tells you the URL).
4. If the failure is real, page the on-call. If the canary itself is buggy, file an issue and disable the check by removing it from `src/checks.ts`.

Surface-specific note:

- **`semantic-index-search`** — explore.wxyc.org's Graph API is 5xx'ing or returning a malformed envelope. This is a real user-facing outage of explore.wxyc.org — check the semantic-index serving host and logs. Historically this flapped nightly ~09:00 UTC on in-process rebuild contention; [semantic-index#347](https://github.com/WXYC/semantic-index/issues/347) moved the rebuild off-host, so a failure here is no longer the expected nightly blip. (If a regression reintroduces nightly ~09:00 UTC flapping, demote back to `pagesOncall: false` and reopen [wxyc-canary#50](https://github.com/WXYC/wxyc-canary/issues/50) rather than training on-call to ignore the page.)
- **`lml-auth`** — a page here is **always a definitive auth verdict**, never a latency blip. Two shapes: the good bearer got a `401/403` (BS#1094 `LML_API_KEY` rotation drift — re-coordinate the bearer rollout across BS + rom + tubafrenzy + canary), or the known-bad bearer got a `200` (`LML_REQUIRE_AUTH` flipped to false or rolled back — re-enable LML auth). A timeout / 5xx / 429 on `/api/v1/lookup` does **not** page: the auth state is then indeterminate and the check returns `skipped` (the cold lookup can exceed the 8s budget — LML availability is covered by `proxy-library-search` and the dj-\* checks). This abstain-on-indeterminate rule was added 2026-06-27 after the cold-`/lookup` latency regression flapped this check every other cycle.
- **`oidc-authorize`** — every OIDC client (flowsheet-digitization verifier today, WikiJS + others planned) is broken until this is green. The message distinguishes the failure classes so the on-call routes to the right fix: a `500` mentioning `oauthConsent` is the BS#1571 replay class (schema drift on `auth_oauth_consent` or a sibling substrate table — check the auth container's Sentry for a `BetterAuthError: [# Drizzle Adapter]: The model "..." was not found in the schema object.`); a `302` with `Location` starting with `dj.wxyc.org/login` is a session-invalidation shape (the sign-in worked but the session was rejected at `/oauth2/authorize` — usually a trusted-client-missing config drift, since the `wxyc-canary` public client from BS#1576 must be registered in `auth_oauth_application`); a `302` with no `code` param is a better-auth regression (bare redirect without issuing a code — file upstream); a state-mismatch is CSRF-material and pages hard. Never log `Set-Cookie` or the `code` — both are session material for the canary DJ. The dedicated `wxyc-canary` public trusted client is deliberately isolated from the flowsheet/wiki.js clients so a canary regression can't rotate a human's OIDC secret.
- **`lml-protected-search`** — LML's own `GET /api/v1/library/search` failed, timed out (3 s budget), or returned zero hits, called directly against LML rather than through the BS proxy. This is BS#1819's protected local-search path (library-metadata-lookup#929) — it should not touch Discogs/Apple/streaming/enrichment code at all, so a failure here means local catalog search itself is broken (SQLite/library.db issue, LML process down, or the isolation contract has regressed), not that an upstream is slow. Check LML's own logs/Sentry for the `/api/v1/library/search` transaction directly; do not assume Discogs is involved.
- **`lml-enrichment-lookup`** (hard-fail branch only — see the dedicated `wxyc-canary-lml-enrichment-degraded` alarm below for the soft-degradation branch) — LML's `POST /api/v1/lookup` failed to answer at all (network error/timeout), returned a non-2xx, or returned zero results with neither `degraded` nor `timeout` set for the canonical WXYC fixture. This is a harder failure than a page from the dedicated degraded alarm: the enrichment lane isn't gracefully shedding, it's not answering or not matching a fixture that should always resolve. If `lml-protected-search` is green at the same time, this is isolated to the Discogs-dependent lane — check LML's Discogs cache/API health, not local catalog search.

### Alarm fires: `wxyc-canary-lml-discogs-breaker-shed`

This is a **separate page alarm** from `wxyc-canary-check-failure` — the `lml-discogs-breaker-shed` check's own status never fails (see `src/checks.ts`), so this signal never shows up as a `CheckFailure`/`UserFacingCheckFailure` datapoint. As of wxyc-canary#84 it's a **volume-gated metric-math alarm** (this repo's first `Metrics:`-array alarm): it fires only when the dimensionless `DiscogsBreakerShedding` metric reads `>= 1` **and** the dimensionless `DiscogsLiveRequestsTotal` counter is advancing (`DIFF() > 0`) for **3 consecutive** 5-minute evaluations (~15 min) — LML's Discogs-saturation breaker has been shedding lookup traffic (`discogs_breaker_state` is `open` or `half-open`) _while live Discogs lookups keep arriving_, and it hasn't recovered on its own. The 3-of-3 window (not the shared alarm's 2-of-3) is intentional: a breaker legitimately trips OPEN for a window or two during real Discogs-side saturation, and that must not page — only shedding-with-traffic that holds is the "never recovers" signature.

A page here means the **idle-tail false positive is ruled out by construction**: a breaker that's idle-latched `open` with no live lookups arriving has a flat `DiscogsLiveRequestsTotal`, so `DIFF()` reads `0` and the gate never trips. If this alarm is firing, real Discogs lookup traffic is hitting the shedding breaker right now.

1. Open CloudWatch → Metrics → `WXYC/Canary` → `DiscogsBreakerShedding` and `DiscogsLiveRequestsTotal` to confirm both the sustained shed and the advancing counter, and check LML's own `/health` for the current `discogs_breaker_state` and `services.discogs_api`.
2. Cross-check via **`api.discogs.com` spans resuming (or not) in Sentry**: query `span.domain:*.discogs.com` (Sentry wildcard-normalizes the domain — the literal `span.domain:api.discogs.com` filter returns zero rows even while live traffic is flowing, and produced a false "still latched" reading during the 2026-07-14 post-fix verification for this exact breaker). `span.op:http.client` grouped by `span.domain` is the reliable shape.
3. Investigate LML's Discogs API quota/rate-limit state and whether the breaker's cooldown is misconfigured (see library-metadata-lookup#787 for the HALF_OPEN-latch class this replaced).
4. **Historical note (pre-#84):** before the volume gate, this alarm could false-page on an idle-latched breaker with zero concurrent lookup traffic — reading `/health` never advances the breaker's `open -> half-open` recovery transition, only a live `/lookup` call does (library-metadata-lookup#939), so an overnight quiet period after a genuine trip left `/health` reporting `open` indefinitely with nobody affected. wxyc-canary#84's `DIFF(DiscogsLiveRequestsTotal) > 0` gate now filters that case out before the alarm ever evaluates true — a stale, non-advancing counter under sustained shed does not page. If this alarm is nonetheless suspected of a false page, that gate itself is the thing to re-verify (a `DiscogsLiveRequestsTotal` counter reset from an LML restart can mask genuine shed traffic for at most 1 of the 3 required periods — see the `template.yaml` comment).

### Alarm fires: `wxyc-canary-lml-enrichment-degraded`

This is a **separate page alarm** from `wxyc-canary-check-failure`, and from `wxyc-canary-lml-discogs-breaker-shed` — it's the BS#1819 isolation-contract signal for the _soft_ half of `lml-enrichment-lookup`'s behavior. The check's own status stays `pass` when LML's `POST /api/v1/lookup` answers with `degraded: true` or `timeout: true` (library-metadata-lookup#930's `LookupResponse` fields) — a deliberate shed under Discogs/upstream pressure, or the internal hard cap firing — so this never shows up as a `CheckFailure`/`UserFacingCheckFailure` datapoint. This alarm fires only when the dimensionless `LookupDegraded` metric reads `>= 1` for **3 consecutive** 5-minute evaluations (~15 min): a single degraded tick is expected occasional behavior under real Discogs pressure (per the BS#1819 PRD, "Discogs-dependent enrichment may degrade when Discogs or another upstream is rate limited"); sustained degradation over ~15 minutes is the page-worthy signature.

A page here means the enrichment lane has been shedding for a sustained window while — importantly — **local catalog search is a separate signal**: check whether `lml-protected-search` is concurrently healthy. If it is, this is isolated to the Discogs-dependent lane exactly as the BS#1819 isolation contract intends, and the runbook is the same as `wxyc-canary-lml-discogs-breaker-shed` above (check LML's `/health` `discogs_breaker_state`, cross-check `api.discogs.com` spans in Sentry via `span.domain:*.discogs.com`, investigate quota/rate-limit state). If `lml-protected-search` is ALSO failing at the same time, that's a bigger, un-isolated degradation — treat it as its own incident, not as this alarm's routine remediation.

1. Open CloudWatch → Metrics → `WXYC/Canary` → `LookupDegraded` to confirm the sustained shed, and check `lml-protected-search`'s status over the same window.
2. Check LML's own `/health` for `discogs_breaker_state` — a concurrent `wxyc-canary-lml-discogs-breaker-shed` page means the two alarms are describing the same underlying Discogs saturation from two angles (the breaker's own state vs. an actual `/lookup` caller experiencing it).
3. A hard failure of `lml-enrichment-lookup` itself (network error, non-2xx, or an unexplained zero-result miss) does **not** route here — it pages via the shared `wxyc-canary-check-failure` alarm instead; see that alarm's `lml-enrichment-lookup` surface note above.

### Alarm fires: `wxyc-canary-infra-degraded`

The low-urgency infra/CI tier (wxyc-canary#48) — `gha-runner-online` or `semantic-index-freshness` has been failing for ≥10 minutes. This does **not** page; it notifies `InfraAlertTopic` only (and only when `InfraAlertEmail` is subscribed). Check the dimensioned `CheckFailure` to see which probe fired.

- **`semantic-index-freshness`** — the served graph DB is stale or empty (semantic-index#348). The check message distinguishes the two failure modes: a `graph_db_age_seconds` breach means the nightly sync stopped landing new graphs (the silent OOM-before-swap class, semantic-index#329) — the serving host is still answering, just from an old DB; check whether the nightly rebuild job is OOM-killing on the t3.small (the semantic-index#347 off-host-rebuild fix is the durable remedy, and this check is expected to fire daily until it lands). An `artist_count` floor breach means a fresh build swapped in an empty or truncated DB — inspect the most recent rebuild's output before it was promoted. Keys on serving-host `/health` freshness, so it survives the #347 migration unchanged.
- **`gha-runner-online`** — the staging-gate runner has been failing its liveness probe. The check message distinguishes the failure mode — route accordingly:
  - **`offline`** — the runner process stopped polling GitHub. SSH to `wxyc-e2e-runner` (per wxyc-shared `scripts/e2e-runner/README.md`) and check `systemctl status 'actions.runner.*.service'`. If the host itself is unreachable, the EC2 instance is wedged — reboot or rebuild from the bootstrap script.
  - **`404 — runner was likely replaced (or PAT lacks Self-hosted runners: Read scope)`** — two-step diagnosis: (1) Confirm the runner id is still current with `gh api /orgs/WXYC/actions/runners --jq '.runners[] | select(.name=="wxyc-e2e-runner")'`. If the id changed, redeploy with the new `GhaRunnerId`. (2) If the id is unchanged, the PAT is missing the `Self-hosted runners: Read` org-level permission — GitHub returns 404 to hide resources from underprivileged tokens. Generate a fresh fine-scoped PAT with the correct scope and overwrite `/wxyc-canary/gha-runner-token`.
  - **`PAT rejected with 401`** — the SSM-stored PAT was revoked, expired, or malformed. Generate a fresh fine-scoped PAT (Self-hosted runners: Read on `WXYC`) and overwrite `/wxyc-canary/gha-runner-token` via `aws ssm put-parameter --overwrite`.
  - **`PAT rejected with 403`** — a genuine, non-rate-limit 403 (PAT rejection). As of wxyc-canary#88 the rate-limit-shaped 403 no longer reaches this branch (it abstains instead — see below), so this message is unambiguous: rotate the PAT, same remediation as 401.
  - **`GitHub API degraded` no longer appears here (wxyc-canary#86), and neither does `GitHub rate limit exceeded` (wxyc-canary#88).** Both are the same "GitHub couldn't answer" class: a GitHub-API 5xx, a network error/timeout reaching github.com, or any rate-limit response (403-primary with `X-RateLimit-Remaining: 0`, 403-secondary with "secondary rate" in the body, or a bare 429) is indeterminate — it says nothing about the runner — so the check abstains (`skipped`) instead of failing. None of these trip this alarm or `wxyc-canary-lambda-errors`. A genuinely-offline runner still returns 200 + `{"status":"offline"}` and still fires the `offline` case above, so no coverage is lost. If you're chasing a suspected GitHub outage, check [githubstatus.com](https://www.githubstatus.com) directly; if you suspect a rate-limit, the skip reason logged for the check includes a wait-time hint when GitHub supplies one — the `X-RateLimit-Reset` epoch on a 403, the `Retry-After` seconds on a 429 — no runner or PAT action is needed either way.

### Alarm fires: `wxyc-canary-lambda-errors`

As of wxyc-canary#87 this alarm is tier-aware: it fires when at least one **page-tier** check failed (belt-and-suspenders alongside `wxyc-canary-check-failure`), or when the Lambda crashed before it could publish per-check metrics at all — a config error (missing env, bad secret), an AWS SDK retry storm, or an unhandled exception. Check the most recent log stream for the stack trace; if the run did publish metrics, the log line's `pageFailures` / `infraOnlyFailures` counts and the dimensioned `CheckFailure` series tell you which check(s) tripped it. An infra-tier-only failure (`gha-runner-online`, `semantic-index-freshness` alone) does **not** trip this alarm — it surfaces only on `wxyc-canary-infra-degraded` instead; see that alarm's entry above.

### A check is too noisy

False positives on a check usually mean its assertion is too tight (e.g., expecting at least 1 row when the table is legitimately empty during low-traffic periods). Loosen the assertion in `src/checks.ts`, write a regression test, redeploy. Don't suppress alerts at the alarm level — that's a slippery slope.

### Adding a new check

Add a new entry to the `checks` array in `src/checks.ts`. The check name becomes a CloudWatch metric dimension, so use kebab-case and keep it stable (renaming it breaks any dashboard that pinned to the old name). Write a test in `test/handler.test.ts` covering both pass and fail shapes.

## Why these specific checks

The check set is deliberately small. Each one corresponds to a real production failure mode that has happened or has plausibly close-relatives. Don't add checks speculatively — every check is an alarm risk surface, and a noisy canary gets ignored. If a new failure mode shows up that the existing checks don't catch, add a check then.

Things this canary does **not** do, on purpose:

- **No writes against another DJ's show.** The v1 write canary (`enrichment-quality`) is gated three ways: `CANARY_ENABLE_WRITE_PROBE=true` must be set, DJ credentials must be configured, and the check skips when another DJ is on-air. The last one is non-negotiable — even if the alarm is on the line, a sentinel row in a real DJ's flowsheet is worse than a missed metric.
- **No iOS-side decoder testing.** The semantic-index check confirms the server returns the right shape, not that iOS decodes it correctly. iOS decoder tests live in `wxyc-ios-64`.
- **No latency SLOs on the read-side checks.** The `CheckLatency` metric is published for trend visibility, not alerting — read-side latency targets are downstream of upstream API behaviour and would mostly produce noise. The `EnrichmentLagSeconds` SLO is the exception: it's measured against the canary's own controlled insert, so a 30 s threshold is meaningful.

## Costs

At the default 5-minute cadence: ~8,640 invocations/month, all under 5 seconds, 256 MB. Lambda cost ~$0.02/month. CloudWatch metrics + alarms ~$1/month. SNS ~$0. Total: under $2/month.

## Related

- WXYC/Backend-Service — the API the canary exercises
- WXYC/semantic-index — explore.wxyc.org Graph API
- The 2026-04-30 incident reports: WXYC/Backend-Service#685, #687, #689; WXYC/wxyc-ios-64#228
