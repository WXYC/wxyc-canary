import { describe, expect, it } from 'vitest';

import { buildCapturePayload, buildFailurePayload, mountPathFrom, sampleWxycMounts } from '../src/stream-sampler.js';

/**
 * A trimmed shape of the real `status-json.xsl` from ibiblio's shared
 * Icecast. The neighbours matter: WXYC is a tenant on a host that also
 * serves several unrelated stations, so every test here doubles as a
 * check that we never count — or emit — somebody else's audience.
 */
const NEIGHBOUR_SOURCES = [
  {
    listenurl: 'http://audio-mp3.ibiblio.org:8000/VRCVLY.mp3',
    listeners: 2,
    listener_peak: 4,
    server_name: 'VRC-VLY Reading Service LIVE',
  },
  {
    listenurl: 'http://audio-mp3.ibiblio.org:8000/concierto',
    listeners: 5,
    listener_peak: 26,
    server_name: 'Concietro',
  },
];

function statusWith(sources: unknown) {
  return { icestats: { host: 'audio-mp3.ibiblio.org', source: sources } };
}

describe('mountPathFrom', () => {
  it('extracts the mount basename from a listenurl with a port', () => {
    expect(mountPathFrom('http://audio-mp3.ibiblio.org:8000/wxyc.mp3')).toBe('wxyc.mp3');
  });

  it('extracts the mount for an extensionless mount', () => {
    expect(mountPathFrom('http://audio-mp3.ibiblio.org:8000/concierto')).toBe('concierto');
  });

  it('returns undefined for a malformed listenurl rather than throwing', () => {
    expect(mountPathFrom('not a url')).toBeUndefined();
    expect(mountPathFrom('')).toBeUndefined();
  });
});

describe('sampleWxycMounts', () => {
  it('sums only the WXYC mounts and ignores co-tenant stations', () => {
    const sample = sampleWxycMounts(
      statusWith([
        ...NEIGHBOUR_SOURCES,
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 25, listener_peak: 69 },
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-alt.mp3', listeners: 3, listener_peak: 8 },
      ])
    );

    expect(sample.totalListeners).toBe(28);
    expect(sample.mountCount).toBe(2);
    expect(sample.streamOnline).toBe(true);
    expect(sample.mounts.map((m) => m.mount)).toEqual(['wxyc-alt.mp3', 'wxyc.mp3']);
    // The neighbours' 7 combined listeners must not appear anywhere.
    expect(JSON.stringify(sample)).not.toContain('concierto');
    expect(JSON.stringify(sample)).not.toContain('VRCVLY');
  });

  it('tracks the primary mount separately from the total', () => {
    const sample = sampleWxycMounts(
      statusWith([
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 25 },
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-alt.mp3', listeners: 3 },
      ])
    );

    expect(sample.primaryListeners).toBe(25);
    expect(sample.totalListeners).toBe(28);
  });

  it('normalizes a single source object into an array', () => {
    // Icecast collapses `source` to a bare object when exactly one mount is
    // connected. Treating that as an array yields zero mounts and a silent
    // undercount — the worst failure mode for an audience metric.
    const sample = sampleWxycMounts(
      statusWith({ listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 11 })
    );

    expect(sample.totalListeners).toBe(11);
    expect(sample.mountCount).toBe(1);
    expect(sample.streamOnline).toBe(true);
  });

  it('auto-includes a newly-added WXYC mount by prefix', () => {
    // Allowlisting exact mount names would undercount the day someone adds a
    // mount. Prefix matching fails toward over-discovery, and `mounts`
    // records what was seen so the drift is visible in the data.
    const sample = sampleWxycMounts(
      statusWith([
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 25 },
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-hd.mp3', listeners: 4 },
      ])
    );

    expect(sample.totalListeners).toBe(29);
    expect(sample.mounts.map((m) => m.mount)).toContain('wxyc-hd.mp3');
  });

  it('reports the stream as offline when no WXYC mount is connected', () => {
    // A dropped encoder is a real observation, not an error: nobody could be
    // listening. It must stay distinguishable from a failed fetch, hence
    // `streamOnline: false` on an otherwise well-formed sample.
    const sample = sampleWxycMounts(statusWith(NEIGHBOUR_SOURCES));

    expect(sample.streamOnline).toBe(false);
    expect(sample.totalListeners).toBe(0);
    expect(sample.mountCount).toBe(0);
    expect(sample.primaryListeners).toBeUndefined();
  });

  it('reports offline when the payload carries no sources at all', () => {
    expect(sampleWxycMounts(statusWith(undefined)).streamOnline).toBe(false);
    expect(sampleWxycMounts({}).streamOnline).toBe(false);
    expect(sampleWxycMounts(null).streamOnline).toBe(false);
  });

  it('coerces a missing or non-numeric listener count to zero', () => {
    const sample = sampleWxycMounts(
      statusWith([
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3' },
        { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-alt.mp3', listeners: 'seven' },
      ])
    );

    expect(sample.totalListeners).toBe(0);
    // The mounts are still connected, so the stream is up even at zero listeners.
    expect(sample.streamOnline).toBe(true);
  });
});

describe('buildCapturePayload', () => {
  const sample = sampleWxycMounts(
    statusWith([
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 25, listener_peak: 69 },
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-alt.mp3', listeners: 3, listener_peak: 8 },
    ])
  );
  const payload = buildCapturePayload(sample, {
    apiKey: 'phc_test',
    timestamp: '2026-08-20T03:34:00.000Z',
    environment: 'production',
  });

  it('captures a single summary event, not one per mount', () => {
    // One event per sample keeps the cost fixed at 288/day regardless of how
    // many mounts appear. Per-mount events would make a billing-relevant
    // number depend on an upstream config we do not control.
    expect(payload.event).toBe('stream_listener_sample');
    expect(payload.api_key).toBe('phc_test');
    expect(payload.timestamp).toBe('2026-08-20T03:34:00.000Z');
  });

  it('uses a stable synthetic distinct_id and suppresses person profiles', () => {
    expect(payload.distinct_id).toBe('wxyc-stream-sampler');
    expect(payload.properties.$process_person_profile).toBe(false);
  });

  it('exposes total_listeners as a flat numeric property for charting', () => {
    expect(payload.properties.total_listeners).toBe(28);
    expect(payload.properties.primary_listeners).toBe(25);
    expect(payload.properties.mount_count).toBe(2);
    expect(payload.properties.stream_online).toBe(true);
    expect(payload.properties.environment).toBe('production');
  });

  it('carries per-mount detail without inventing per-mount property names', () => {
    expect(payload.properties.mounts).toEqual([
      { mount: 'wxyc-alt.mp3', listeners: 3, peak: 8 },
      { mount: 'wxyc.mp3', listeners: 25, peak: 69 },
    ]);
  });
});

describe('buildFailurePayload', () => {
  const payload = buildFailurePayload({
    apiKey: 'phc_test',
    timestamp: '2026-08-20T03:34:00.000Z',
    environment: 'production',
    reason: 'status 503',
  });

  it('emits a distinct event so failures never read as zero listeners', () => {
    // Capturing total_listeners: 0 on a fetch failure would silently drag the
    // AQH average down. A separate event keeps the two apart at query time.
    expect(payload.event).toBe('stream_listener_sample_failed');
    expect(payload.properties.reason).toBe('status 503');
    expect(payload.properties).not.toHaveProperty('total_listeners');
    expect(payload.properties.$process_person_profile).toBe(false);
  });
});
