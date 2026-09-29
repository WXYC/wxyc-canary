import { afterEach, describe, expect, it, vi } from 'vitest';

import { handler, loadConfig, runSampler, type SamplerConfig } from '../src/stream-sampler-handler.js';

const FIXED_NOW = () => new Date('2026-08-20T03:34:00.000Z');

function configWith(overrides: Partial<SamplerConfig> = {}): SamplerConfig {
  return {
    statusUrl: 'https://icecast.test/status-json.xsl',
    posthogHost: 'https://posthog.test',
    posthogApiKey: 'phc_test',
    environment: 'production',
    mountPrefix: 'wxyc',
    primaryMount: 'wxyc.mp3',
    timeoutMs: 1000,
    captureEnabled: true,
    familyAttemptTimeoutMs: 3000,
    readRetries: 1,
    onAirUrl: 'https://api.test/flowsheet?limit=1',
    onAirTimeoutMs: 1000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type FetchSpy = { mock: { calls: Parameters<typeof fetch>[] } };

function captureCalls(spy: FetchSpy) {
  return spy.mock.calls.filter(([input]) => String(input).startsWith('https://posthog.test/'));
}

function captureCall(spy: FetchSpy) {
  const calls = captureCalls(spy);
  expect(calls).toHaveLength(1);
  return calls[0];
}

const HEALTHY_STATUS = {
  icestats: {
    source: [
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 25, listener_peak: 69 },
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-alt.mp3', listeners: 3, listener_peak: 8 },
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/concierto', listeners: 5 },
    ],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('defaults to the ibiblio status endpoint over HTTPS', () => {
    // Plain http:// on this host does not answer — it returns an empty body,
    // which would parse as a failure on every tick.
    const config = loadConfig({});
    expect(config.statusUrl).toBe('https://audio-mp3.ibiblio.org/status-json.xsl');
    expect(config.posthogHost).toBe('https://us.i.posthog.com');
    expect(config.captureEnabled).toBe(true);
  });

  it('reads the on-air DJ from the paginated flowsheet branch, one entry deep', () => {
    // Only the paginated branch carries `on_air`. The parameter is `limit`:
    // `?n=1` is silently ignored and returns the default 30 entries.
    expect(loadConfig({}).onAirUrl).toBe('https://api.wxyc.org/flowsheet?limit=1');
  });

  it('gives the on-air read a budget well inside the status read', () => {
    const config = loadConfig({});
    expect(config.onAirTimeoutMs).toBe(3000);
    expect(config.onAirTimeoutMs).toBeLessThan(config.timeoutMs);
    expect(loadConfig({ SAMPLER_ON_AIR_TIMEOUT_MS: 'soon' }).onAirTimeoutMs).toBe(3000);
  });

  it.each<[string, Record<string, string>, number]>([
    ['the default status budget', { SAMPLER_ON_AIR_TIMEOUT_MS: '40000' }, 8000],
    ['a tuned status budget', { SAMPLER_ON_AIR_TIMEOUT_MS: '40000', SAMPLER_TIMEOUT_MS: '5000' }, 5000],
  ])('caps the on-air budget at one status attempt, against %s', (_label, env, expected) => {
    // When Icecast fails fast, the failure path waits out the on-air read
    // before its own capture. An uncapped 40s budget there overruns the 45s
    // Lambda timeout, and the killed invocation leaves neither an event nor a
    // log line. Capped at one status attempt, the worst case stays at the
    // retried read plus the capture that the Lambda timeout is sized for.
    expect(loadConfig(env).onAirTimeoutMs).toBe(expected);
  });

  it('treats a blank api key as capture-disabled rather than substituting a default', () => {
    expect(loadConfig({ SAMPLER_POSTHOG_API_KEY: '' }).posthogApiKey).toBe('');
  });

  it('falls back to defaults for unparseable numeric env vars', () => {
    // An unguarded Number() turns a typo into a silent outage: NaN retries
    // skip the fetch loop entirely, and NaN into the family-attempt setter
    // throws before any event can be emitted.
    const config = loadConfig({
      SAMPLER_READ_RETRIES: 'on',
      SAMPLER_TIMEOUT_MS: 'fast',
      SAMPLER_FAMILY_ATTEMPT_TIMEOUT_MS: '',
    });

    expect(config.readRetries).toBe(1);
    expect(config.timeoutMs).toBe(8000);
    expect(config.familyAttemptTimeoutMs).toBe(3000);
  });
});

describe('runSampler', () => {
  it('samples the WXYC mounts and POSTs one event to the capture API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) return jsonResponse(HEALTHY_STATUS);
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith(), FIXED_NOW);

    expect(result.captured).toBe(true);
    expect(result.totalListeners).toBe(28);
    expect(result.streamOnline).toBe(true);
    expect(result.mounts).toEqual(['wxyc-alt.mp3', 'wxyc.mp3']);

    // Exactly three calls: the status read, the on-air read, and one capture.
    // No batching, no retries.
    expect(fetchSpy.mock.calls.map(([input]) => new URL(String(input)).host).sort()).toEqual([
      'api.test',
      'icecast.test',
      'posthog.test',
    ]);
    const [captureUrl, captureInit] = captureCall(fetchSpy);
    expect(String(captureUrl)).toBe('https://posthog.test/i/v0/e/');
    expect(captureInit?.method).toBe('POST');

    const body = JSON.parse(String(captureInit?.body));
    expect(body.event).toBe('stream_listener_sample');
    expect(body.api_key).toBe('phc_test');
    expect(body.timestamp).toBe('2026-08-20T03:34:00.000Z');
    expect(body.properties.total_listeners).toBe(28);
    // The co-tenant station must not ride along.
    expect(String(captureInit?.body)).not.toContain('concierto');
  });

  it('captures a failure event when the status endpoint errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) return jsonResponse({ error: 'nope' }, 503);
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith(), FIXED_NOW);

    expect(result.event).toBe('stream_listener_sample_failed');
    expect(result.totalListeners).toBeNull();
    expect(result.captured).toBe(true);
    expect(result.reason).toContain('503');
  });

  it('captures a failure event when the fetch throws outright', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) throw new Error('ECONNREFUSED');
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith(), FIXED_NOW);
    expect(result.event).toBe('stream_listener_sample_failed');
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('records a well-formed zero sample when the encoder is disconnected', async () => {
    // Distinct from a failure: the fetch succeeded and told us nobody is
    // connected because no WXYC mount exists right now.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) {
        return jsonResponse({ icestats: { source: [{ listenurl: 'http://x/concierto', listeners: 5 }] } });
      }
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith(), FIXED_NOW);
    expect(result.event).toBe('stream_listener_sample');
    expect(result.streamOnline).toBe(false);
    expect(result.totalListeners).toBe(0);
  });

  it('does not contact PostHog when capture is disabled', async () => {
    // A fresh Response per call: a body can be read once, and both the status
    // read and the on-air read consume one.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(HEALTHY_STATUS));

    const result = await runSampler(configWith({ captureEnabled: false }), FIXED_NOW);

    expect(result.captured).toBe(false);
    expect(result.totalListeners).toBe(28);
    expect(captureCalls(fetchSpy)).toHaveLength(0);
    // Must name the lever that actually fired — the operator note tells
    // readers that "no api key" means a CloudFormation problem.
    expect(result.reason).toContain('SAMPLER_CAPTURE_ENABLED=false');
  });

  it('does not contact PostHog when no api key is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse(HEALTHY_STATUS));

    const result = await runSampler(configWith({ posthogApiKey: undefined }), FIXED_NOW);

    expect(result.captured).toBe(false);
    expect(captureCalls(fetchSpy)).toHaveLength(0);
    expect(result.reason).toContain('capture disabled');
  });

  it('retries a failed status read and succeeds on the second attempt', async () => {
    // The ibiblio host is dual-stack and intermittently slow; a single
    // transient read failure must not punch a hole in the time series.
    let statusCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error('ETIMEDOUT');
        return jsonResponse(HEALTHY_STATUS);
      }
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith(), FIXED_NOW);

    expect(statusCalls).toBe(2);
    expect(result.totalListeners).toBe(28);
    expect(result.event).toBe('stream_listener_sample');
  });

  it('gives up after the configured retry budget and reports failure', async () => {
    let statusCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) {
        statusCalls += 1;
        throw new Error('ETIMEDOUT');
      }
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith({ readRetries: 1 }), FIXED_NOW);

    expect(statusCalls).toBe(2);
    expect(result.event).toBe('stream_listener_sample_failed');
  });

  it('never retries the capture write, even though it retries the read', async () => {
    // A capture that timed out may already have landed. Re-sending would
    // double-count a quarter-hour, which is worse than dropping the sample.
    let captureCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) return jsonResponse(HEALTHY_STATUS);
      if (String(input).includes('api.test')) return jsonResponse({ on_air: null });
      captureCalls += 1;
      throw new Error('ETIMEDOUT');
    });

    await expect(runSampler(configWith(), FIXED_NOW)).rejects.toThrow();
    expect(captureCalls).toBe(1);
  });

  it('surfaces a non-2xx from the capture API as a thrown error', async () => {
    // The invocation must fail loudly: a swallowed capture error would look
    // like a healthy tick while the time series quietly develops a hole.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) return jsonResponse(HEALTHY_STATUS);
      return jsonResponse({ error: 'bad key' }, 401);
    });

    await expect(runSampler(configWith(), FIXED_NOW)).rejects.toThrow(/posthog capture returned 401/);
  });
});

describe('runSampler — on-air attribution', () => {
  /**
   * Routes the three hosts: Icecast answers healthily, the capture API
   * accepts, and the flowsheet answers with whatever the test supplies.
   */
  function stubFetch(flowsheet: (init: RequestInit | undefined) => Promise<Response>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('icecast.test')) return jsonResponse(HEALTHY_STATUS);
      if (url.includes('api.test')) return flowsheet(init);
      return jsonResponse({ status: 1 });
    });
  }

  function capturedProperties(spy: FetchSpy) {
    const [, init] = captureCall(spy);
    return JSON.parse(String(init?.body)).properties;
  }

  it('records the live DJ on the sample', async () => {
    const spy = stubFetch(async () => jsonResponse({ entries: [], on_air: { dj_name: 'dj pipe dreams' } }));

    const result = await runSampler(configWith(), FIXED_NOW);

    expect(result.onAirState).toBe('dj');
    expect(result.djName).toBe('dj pipe dreams');
    expect(capturedProperties(spy)).toMatchObject({
      total_listeners: 28,
      on_air_state: 'dj',
      dj_name: 'dj pipe dreams',
    });
  });

  it('records automation with no DJ name', async () => {
    const spy = stubFetch(async () => jsonResponse({ entries: [], on_air: null }));

    await runSampler(configWith(), FIXED_NOW);

    const properties = capturedProperties(spy);
    expect(properties.on_air_state).toBe('automation');
    expect(properties).not.toHaveProperty('dj_name');
  });

  // A skipped sample is unrecoverable (docs/scope.md) and the audience number
  // is the job's whole purpose, so no flowsheet failure may cost the sample:
  // each one degrades to `unknown` with the listener count untouched.
  it.each<[string, (init: RequestInit | undefined) => Promise<Response>, RegExp]>([
    [
      'throws',
      async () => {
        throw new Error('ECONNREFUSED');
      },
      /ECONNREFUSED/,
    ],
    [
      'times out',
      // Hangs until canaryFetch's own abort fires, so this exercises the real
      // per-request timeout rather than a simulated one.
      (init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        }),
      /timed out after 20ms/,
    ],
    [
      'returns malformed JSON',
      async () => new Response('<html>Bad Gateway</html>', { status: 200 }),
      /not a JSON object/,
    ],
    ['returns a non-2xx', async () => jsonResponse({ error: 'down' }, 503), /503/],
  ])('still captures the sample when the flowsheet read %s', async (_label, flowsheet, reason) => {
    const spy = stubFetch(flowsheet);

    const result = await runSampler(configWith({ onAirTimeoutMs: 20 }), FIXED_NOW);

    expect(result.captured).toBe(true);
    expect(result.event).toBe('stream_listener_sample');
    expect(result.onAirState).toBe('unknown');
    expect(result.onAirReason).toMatch(reason);
    const properties = capturedProperties(spy);
    expect(properties.total_listeners).toBe(28);
    expect(properties.on_air_state).toBe('unknown');
    expect(properties).not.toHaveProperty('dj_name');
  });

  it('never retries the flowsheet read', async () => {
    // The Icecast read is the one retried read; a second flowsheet attempt
    // would only push the sample later for a property that can degrade.
    let flowsheetCalls = 0;
    stubFetch(async () => {
      flowsheetCalls += 1;
      throw new Error('ECONNREFUSED');
    });

    await runSampler(configWith(), FIXED_NOW);

    expect(flowsheetCalls).toBe(1);
  });

  it('leaves the failure event unchanged', async () => {
    // `stream_listener_sample_failed` records that we could not measure. An
    // on-air state there would invite reading it as attributed airtime.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('icecast.test')) return jsonResponse({ error: 'nope' }, 503);
      if (url.includes('api.test')) return jsonResponse({ entries: [], on_air: { dj_name: 'dj pipe dreams' } });
      return jsonResponse({ status: 1 });
    });

    const result = await runSampler(configWith(), FIXED_NOW);

    expect(result.event).toBe('stream_listener_sample_failed');
    const properties = capturedProperties(spy);
    expect(Object.keys(properties).sort()).toEqual(['$process_person_profile', 'environment', 'reason', 'source']);
  });
});

describe('handler', () => {
  it('logs a structured line even when the capture throws', async () => {
    // This function publishes no CloudWatch metrics and owns no alarms, and
    // the canary's lambda-errors alarm is dimensioned to CanaryFunction, so
    // it does not cover this one. If a capture failure escaped without a log
    // line, a rotated token would stop sampling with nothing but an
    // unwatched stack trace to show for it.
    vi.stubEnv('SAMPLER_ICECAST_STATUS_URL', 'https://icecast.test/status-json.xsl');
    vi.stubEnv('SAMPLER_POSTHOG_HOST', 'https://posthog.test');
    vi.stubEnv('SAMPLER_POSTHOG_API_KEY', 'phc_test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('icecast.test')) return jsonResponse(HEALTHY_STATUS);
      return jsonResponse({ error: 'bad key' }, 401);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(handler()).rejects.toThrow(/401/);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(logged.sampler).toBe('wxyc-stream-listeners');
    expect(logged.captured).toBe(false);
    expect(logged.reason).toContain('401');
  });
});
