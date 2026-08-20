import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, runSampler, type SamplerConfig } from '../src/stream-sampler-handler.js';

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
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

  it('treats a blank api key as capture-disabled rather than substituting a default', () => {
    expect(loadConfig({ SAMPLER_POSTHOG_API_KEY: '' }).posthogApiKey).toBe('');
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

    // Exactly two calls: one read, one capture. No batching, no retries.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [captureUrl, captureInit] = fetchSpy.mock.calls[1];
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(HEALTHY_STATUS));

    const result = await runSampler(configWith({ captureEnabled: false }), FIXED_NOW);

    expect(result.captured).toBe(false);
    expect(result.totalListeners).toBe(28);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not contact PostHog when no api key is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(HEALTHY_STATUS));

    const result = await runSampler(configWith({ posthogApiKey: undefined }), FIXED_NOW);

    expect(result.captured).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
