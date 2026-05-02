# wxyc-canary

Synthetic-DJ canary that exercises the WXYC user-facing API surface every five minutes from AWS Lambda. Catches outages on the paths a DJ actually touches before a DJ on-air does.

The canary exists because three production incidents on 2026-04-30 (catalog-search 503, flowsheet POST 500, semantic-index decoder drift) were all detected by users hitting them rather than by any monitor. Each one would have surfaced as a CheckFailure metric on this canary within five minutes of going wrong.

## What it checks

| Check                   | Endpoint                                                                | Auth             | What it would have caught                           |
| ----------------------- | ----------------------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| `backend-healthcheck`   | `GET /healthcheck`                                                      | none             | Process-level outage on Backend-Service             |
| `proxy-library-search`  | `GET /proxy/library/search?artist=Stereolab&limit=5`                    | anonymous device | LML degradation, BS proxy regressions               |
| `semantic-index-search` | `GET https://explore.wxyc.org/graph/artists/search?q=Stereolab&limit=1` | none             | semantic-index 5xx; missing `results` envelope      |
| `dj-library-search`     | `GET /library/?artist_name=Stereolab&n=5`                               | DJ JWT           | The 2026-04-30 catalog-search 503 incident, exactly |
| `dj-flowsheet-read`     | `GET /v2/flowsheet?n=5`                                                 | DJ JWT           | V2 flowsheet read regressions                       |
| `dj-rotation`           | `GET /library/rotation`                                                 | DJ JWT           | Rotation endpoint 5xx, fully empty rotation         |

DJ-auth checks downgrade to `skipped` (a distinct CloudWatch metric, not `failed`) when no DJ credentials are configured, so the alarm doesn't fire on operator-caused gaps.

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
- Per-check metrics: `CheckFailure`, `CheckSkipped`, `CheckLatency`, all dimensioned on `Check=<name>`.
- Three alarms: `wxyc-canary-check-failure` (any check failed in 2 of last 3 evaluations), `wxyc-canary-lambda-errors` (Lambda crashed before publishing metrics), and `wxyc-canary-mutation-4xx-surge` (sustained surge of Backend-Service mutation 4xx responses on `/flowsheet/*`, threshold SUM > 20 per 5-min window for 2 windows; reads the `MutationClientError` metric in the `WXYC/BackendService` namespace emitted by BS#704).

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
    AlertEmail=ops@wxyc.org
```

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

### Alarm fires: `wxyc-canary-mutation-4xx-surge`

A sustained surge of 4xx responses on Backend-Service mutation routes (`POST/PATCH/DELETE` on `/flowsheet/*`). The alarm reads the `MutationClientError` CloudWatch metric in the `WXYC/BackendService` namespace, emitted by Backend-Service per WXYC/Backend-Service#704. Sentry no longer captures these (handled-error filter from BS#691), so the trace explorer is the right place to triage:

1. Open Sentry → trace explorer → filter `transaction:[POST /flowsheet/, PATCH /flowsheet/, DELETE /flowsheet/]` over the last 30 min. The span tags carry route + status code; group by `http.status_code` to see which class of 4xx is surging.
2. Common cases: `showMemberMiddleware` 403 (DJ session lost show membership — check the recent flowsheet/rotation incident notes), validation 422 (request shape regression — usually a recent dj-site or iOS deploy), rate-limit 429 (a client retry storm).
3. If the surge correlates with a recent Backend-Service or dj-site deploy, that's the first suspect. If it's isolated to one DJ session, the on-air DJ may be hitting a stale/expired session token and need to re-sign-in.
4. The alarm threshold is SUM > 20 per 5-min window for 2 windows (sustained > 4/min for 10 min). One-off transient bursts won't trip it; if you're seeing churn at the threshold edge, raise the threshold rather than re-triggering manually.

### A check is too noisy

False positives on a check usually mean its assertion is too tight (e.g., expecting at least 1 row when the table is legitimately empty during low-traffic periods). Loosen the assertion in `src/checks.ts`, write a regression test, redeploy. Don't suppress alerts at the alarm level — that's a slippery slope.

### Adding a new check

Add a new entry to the `checks` array in `src/checks.ts`. The check name becomes a CloudWatch metric dimension, so use kebab-case and keep it stable (renaming it breaks any dashboard that pinned to the old name). Write a test in `test/handler.test.ts` covering both pass and fail shapes.

## Why these specific checks

The check set is deliberately small. Each one corresponds to a real production failure mode that has happened or has plausibly close-relatives. Don't add checks speculatively — every check is an alarm risk surface, and a noisy canary gets ignored. If a new failure mode shows up that the existing checks don't catch, add a check then.

Things this canary does **not** do, on purpose:

- **No write probes in v0.** The catalog-search 503 and rotation regressions are read-side. The flowsheet POST 500 is write-side, but a write-probing canary needs a clean cleanup story so its writes don't pollute real flowsheet data — that's a v1 design problem with its own tradeoffs.
- **No iOS-side decoder testing.** The semantic-index check confirms the server returns the right shape, not that iOS decodes it correctly. iOS decoder tests live in `wxyc-ios-64`.
- **No latency SLOs.** The latency metric is published for trend visibility, not alerting. Adding a SLO without a clear baseline mostly produces noise.

## Costs

At the default 5-minute cadence: ~8,640 invocations/month, all under 5 seconds, 256 MB. Lambda cost ~$0.02/month. CloudWatch metrics + alarms ~$1/month. SNS ~$0. Total: under $2/month.

## Related

- WXYC/Backend-Service — the API the canary exercises
- WXYC/semantic-index — explore.wxyc.org Graph API
- The 2026-04-30 incident reports: WXYC/Backend-Service#685, #687, #689; WXYC/wxyc-ios-64#228
