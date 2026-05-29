# wxyc-canary

Synthetic-DJ canary that exercises the WXYC user-facing API surface every five minutes from AWS Lambda. Catches outages on the paths a DJ actually touches before a DJ on-air does.

The canary exists because three production incidents on 2026-04-30 (catalog-search 503, flowsheet POST 500, semantic-index decoder drift) were all detected by users hitting them rather than by any monitor. Each one would have surfaced as a CheckFailure metric on this canary within five minutes of going wrong.

## What it checks

| Check                   | Endpoint                                                                | Auth             | What it would have caught                                        |
| ----------------------- | ----------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `backend-healthcheck`   | `GET /healthcheck`                                                      | none             | Process-level outage on Backend-Service                          |
| `proxy-library-search`  | `GET /proxy/library/search?artist=Stereolab&limit=5`                    | anonymous device | LML degradation, BS proxy regressions                            |
| `semantic-index-search` | `GET https://explore.wxyc.org/graph/artists/search?q=Stereolab&limit=1` | none             | semantic-index 5xx; missing `results` envelope                   |
| `dj-library-search`     | `GET /library/?artist_name=Stereolab&n=5`                               | DJ JWT           | The 2026-04-30 catalog-search 503 incident, exactly              |
| `dj-flowsheet-read`     | `GET /v2/flowsheet?n=5`                                                 | DJ JWT           | V2 flowsheet read regressions                                    |
| `dj-rotation`           | `GET /library/rotation`                                                 | DJ JWT           | Rotation endpoint 5xx, fully empty rotation                      |
| `enrichment-quality`    | insert sentinel → poll for enrichment → delete                          | DJ JWT (write)   | The 2026-05-13 LML cascade regression (null-metadata on inserts) |

DJ-auth checks downgrade to `skipped` (a distinct CloudWatch metric, not `failed`) when no DJ credentials are configured, so the alarm doesn't fire on operator-caused gaps. The `enrichment-quality` write canary additionally requires `CANARY_ENABLE_WRITE_PROBE=true` and skips when another DJ is on-air — the canary deliberately doesn't inject sentinel rows into a real DJ's flowsheet.

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
- Per-check metrics: `CheckFailure`, `CheckSkipped`, `CheckLatency`, all dimensioned on `Check=<name>`. Plus `EnrichmentLagSeconds` from the v1 write canary (dimensioned + dimensionless).
- Three alarms: `wxyc-canary-check-failure` (any check failed in 2 of last 3 evaluations), `wxyc-canary-enrichment-lag` (sentinel row took > 30 s to enrich for 3 consecutive evaluations), and `wxyc-canary-lambda-errors` (Lambda crashed before publishing metrics).

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
export CANARY_LOCAL=true
npm run local
```

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

Leave `EnableWriteProbe=false` for the first deploy. Once the DJ test account is provisioned, the `wxyc-canary-enrichment-lag` alarm is wired to the right SNS subscriber, and you've verified cleanup behaviour in a manual local run (`CANARY_ENABLE_WRITE_PROBE=true CANARY_LOCAL=true npm run local` against a non-prod environment), redeploy with `EnableWriteProbe=true` to turn the write canary on.

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

When you want canary failures to land as GitHub issues for morning triage (instead of, or in addition to, SNS email), wire a fine-scoped PAT through SSM Parameter Store and pass two stack parameters. The reporter is best-effort and non-fatal: a GitHub outage never masks the canary's primary signal (the dimensionless `CheckFailure` series). SNS + the `wxyc-canary-lambda-errors` alarm stay armed as the fallback for when the Lambda itself dies before the reporter runs.

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

### CI deploys

`.github/workflows/deploy.yml` builds + deploys on push to `main`. Required GitHub secrets:

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — same shape as Backend-Service
- `DJ_CREDENTIALS_SECRET_ARN` — the ARN from step 2 above

Required GitHub variables (override defaults if needed):

- `BACKEND_URL`, `AUTH_URL`, `SEMANTIC_INDEX_URL`, `ALERT_EMAIL`

## Operating runbook

### Alarm fires: `wxyc-canary-check-failure`

1. Open CloudWatch → Metrics → `WXYC/Canary` → `CheckFailure`. The `Check` dimension names which surface is broken.
2. Tail the canary log: `aws logs tail /aws/lambda/wxyc-canary --since 30m`. Each invocation prints a JSON line with all six outcomes.
3. Reproduce the failing endpoint manually (the `description` column above tells you the URL).
4. If the failure is real, page the on-call. If the canary itself is buggy, file an issue and disable the check by removing it from `src/checks.ts`.

### Alarm fires: `wxyc-canary-lambda-errors`

The Lambda crashed before it could publish per-check metrics. Usually means a config error (missing env, bad secret), an AWS SDK retry storm, or an unhandled exception. Check the most recent log stream for the stack trace.

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
