# What this is not

- Not a load test. One synthetic call per check per five minutes.
- Not an iOS test. The semantic-index check confirms the server's contract, not that iOS decodes it.
- The v1 write canary (`enrichment-quality`) is opt-in via `CANARY_ENABLE_WRITE_PROBE=true`. When enabled, every invocation start-show / log-sentinel / poll / delete / end-show — see `src/enrichment-check.ts` for the cleanup invariants. When disabled, the check downgrades to `skipped` and the `wxyc-canary-enrichment-lag` alarm stays at OK (`TreatMissingData: notBreaching`).

## The stream listener sampler is not a canary

`wxyc-canary-stream-listener-sampler` shares this repo but is a different kind of job, and the distinction is load-bearing:

- **It measures an audience, it does not assert liveness.** It records how many people are connected to the WXYC Icecast mounts so that number can be compared against broadcast ratings. A low number is a fact about the audience, not a fault.
- **It owns no alarms and publishes no CloudWatch metrics.** Its only outputs are a PostHog event and a log line. It can never page, and an alarm suppression can never silence it.
- **It retries; the canary does not.** The no-retry rule exists so a flaky retry can't mask a brownout. For a sampler the calculus inverts: a dropped read is a hole in a continuous time series, so the read is retried once. The PostHog write is never retried — a write that timed out may have landed, and a duplicate sample double-counts a quarter-hour.
- **A paused schedule loses data.** `StreamSamplerState=DISABLED` is a real lever, but unlike skipping a probe, a skipped sample is unrecoverable.

Why it lives here anyway: it reuses the SAM/deploy/test plumbing and runs in the same WXYC AWS account. It is a separate Lambda, separate schedule, separate log group.
