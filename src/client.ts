/**
 * Thin HTTP wrapper that the checks share. Adds a per-request timeout
 * (AbortController) because the platform fetch has no default — the canary
 * has a hard wall-clock budget per Lambda invocation and a hung request
 * shouldn't burn the whole run. No retries: a flaky retry can mask a real
 * brownout, which is the opposite of what a canary is for.
 */
export type FetchResult = {
  status: number;
  ok: boolean;
  body: unknown;
  latencyMs: number;
  /** Raw text body. Useful for failure messages when JSON parse fails. */
  rawText: string;
  /** Lowercased response headers. Used for things like `Retry-After`. */
  headers: Record<string, string>;
  /**
   * The `Location` response header, or `undefined` when absent. Read
   * through this instead of `headers?.location`: `canaryFetch` lowercases
   * on the way out, so the string works today, but a call-site that types
   * `Location` (title-case) silently reads `undefined` and fails the
   * check with a misleading "no Location header" instead of the actual
   * regression. The typed accessor enforces the lowercasing in one place,
   * hides the `?.` chain, and gives TypeScript a discoverable field for
   * every future 3xx-inspection call site. See wxyc-canary#64.
   */
  location: string | undefined;
  /**
   * The `Retry-After` header parsed as milliseconds (seconds form only —
   * the date form is rare on better-auth and not handled). Returns
   * `undefined` when the header is missing/unparseable/negative. Same
   * rationale as `location`: the lowercasing + parsing happens in one
   * place so a call-site can't type `Retry-After` (title-case) or skip
   * the negative-check and silently do the wrong thing. See
   * wxyc-canary#64.
   */
  retryAfterMs: number | undefined;
};

export class CanaryFetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CanaryFetchError';
  }
}

export async function canaryFetch(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    method?: string;
    body?: string;
    /**
     * Redirect handling. Defaults to platform default (follow). Set to
     * `'manual'` when the check needs to inspect the 3xx `Location` header
     * without following it — the OIDC authorize probe (wxyc-canary#60) is
     * the sole consumer today: it reads the 302 back to the trusted
     * client's `redirect_uri` with a `code=` query param and stops there.
     * Never `'error'` — the canary already has structured failure handling
     * for non-2xx responses; converting a 3xx into a thrown network error
     * would lose the status + Location context.
     */
    redirect?: 'follow' | 'manual';
  } = {}
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      redirect: options.redirect,
      signal: controller.signal,
    });
    const rawText = await response.text();
    const latencyMs = Math.round(performance.now() - startedAt);

    let body: unknown = rawText;
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch {
        // Leave body as the raw string; non-JSON responses are common on errors.
      }
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Retry-After: seconds form only (the date form is rare on
    // better-auth and not handled). Negative / non-finite / missing all
    // collapse to `undefined` so a call-site can pattern-match on
    // "known-good delay" vs "no signal" without duplicating the parse.
    let retryAfterMs: number | undefined;
    const retryAfterRaw = headers['retry-after'];
    if (retryAfterRaw) {
      const seconds = Number(retryAfterRaw);
      if (Number.isFinite(seconds) && seconds >= 0) {
        retryAfterMs = Math.round(seconds * 1000);
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      body,
      latencyMs,
      rawText,
      headers,
      location: headers.location,
      retryAfterMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startedAt);
    if ((err as Error).name === 'AbortError') {
      throw new CanaryFetchError(`request to ${url} timed out after ${timeoutMs}ms`, err);
    }
    throw new CanaryFetchError(`request to ${url} failed after ${latencyMs}ms: ${(err as Error).message}`, err);
  } finally {
    clearTimeout(timer);
  }
}
