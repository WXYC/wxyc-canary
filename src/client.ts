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
  options: { headers?: Record<string, string>; timeoutMs?: number; method?: string; body?: string } = {}
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

    return {
      status: response.status,
      ok: response.ok,
      body,
      latencyMs,
      rawText,
      headers,
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
