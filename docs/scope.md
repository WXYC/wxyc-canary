# What this is not

- Not a load test. One synthetic call per check per five minutes.
- Not an iOS test. The semantic-index check confirms the server's contract, not that iOS decodes it.
- The v1 write canary (`enrichment-quality`) is opt-in via `CANARY_ENABLE_WRITE_PROBE=true`. When enabled, every invocation start-show / log-sentinel / poll / delete / end-show — see `src/enrichment-check.ts` for the cleanup invariants. When disabled, the check downgrades to `skipped` and the `wxyc-canary-enrichment-lag` alarm stays at OK (`TreatMissingData: notBreaching`).
