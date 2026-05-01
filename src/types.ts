/**
 * A single canary check that exercises one user-facing surface of the WXYC
 * stack. Each check returns a result; failures don't throw — they're a
 * first-class state so a single broken endpoint doesn't short-circuit the
 * rest of the run.
 */
export type Check = {
  /** Stable identifier; used as a CloudWatch metric dimension. Keep [a-z-]+ so it's grep-friendly. */
  name: string;
  /** Human-readable description shown in alerts. */
  description: string;
  /** Whether this check can run without DJ credentials. */
  requiresAuth: boolean;
  /** The actual probe. Throws on failure with a message that's safe to alert on. */
  run: (ctx: CheckContext) => Promise<void>;
};

export type CheckContext = {
  backendUrl: string;
  authUrl: string;
  semanticIndexUrl: string;
  /** Bearer token if the canary has logged in as a DJ; undefined for anonymous-only runs. */
  djBearerToken: string | undefined;
};

export type CheckOutcome = {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  latencyMs: number;
  /** Failure message if status === 'fail'. */
  message?: string;
};

export type CanaryConfig = {
  backendUrl: string;
  authUrl: string;
  semanticIndexUrl: string;
  /** Optional DJ login. If unset, DJ-auth checks are skipped (not failed). */
  djEmail?: string;
  djPassword?: string;
  /** Per-check timeout, ms. Defaults to 8000. */
  timeoutMs?: number;
  /** AWS region for CloudWatch metric publishing. Defaults to us-east-1. */
  awsRegion?: string;
  /** Disable CloudWatch metric publishing (used in local + test runs). */
  publishMetrics?: boolean;
};
