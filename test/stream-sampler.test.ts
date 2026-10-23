import { describe, expect, it } from 'vitest';

import {
  type OnAir,
  buildCapturePayload,
  buildFailurePayload,
  mountPathFrom,
  parseLatestEntryAt,
  parseOnAir,
  sampleWxycMounts,
} from '../src/stream-sampler.js';

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

  it('matches the prefix case-insensitively on both sides', () => {
    // `SAMPLER_MOUNT_PREFIX=WXYC` is the natural way to spell call letters.
    // Lowercasing only the mount would match nothing and emit a permanent
    // zero indistinguishable from a dropped encoder.
    const sample = sampleWxycMounts(
      statusWith([{ listenurl: 'http://audio-mp3.ibiblio.org:8000/WXYC.mp3', listeners: 12 }]),
      { mountPrefix: 'WXYC', primaryMount: 'WXYC.mp3' }
    );

    expect(sample.totalListeners).toBe(12);
    expect(sample.primaryListeners).toBe(12);
    expect(sample.streamOnline).toBe(true);
  });

  it('accepts a numeric string listener count', () => {
    // Icecast builds differ in which fields they quote. Reading "25" as zero
    // would flatten the series while everything else still looked healthy.
    const sample = sampleWxycMounts(
      statusWith([{ listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: '25' }])
    );

    expect(sample.totalListeners).toBe(25);
    expect(sample.unparseableListenerCounts).toBe(0);
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
    // ...but the anomaly is surfaced rather than silently booked as zero.
    expect(sample.unparseableListenerCounts).toBe(2);
  });
});

describe('parseOnAir', () => {
  // The three shapes Backend-Service's paginated `GET /flowsheet` gives
  // `on_air` (flowsheet.controller.ts, the `res.status(200).json` of the
  // default branch): an object when a human is live, explicit `null` when
  // automation is, and the field absent when the banner query itself failed.
  it.each<[string, unknown, OnAir['state'], string | undefined]>([
    ['an object names the live DJ', { on_air: { dj_name: 'dj pipe dreams' } }, 'dj', 'dj pipe dreams'],
    ['explicit null is automation', { on_air: null }, 'automation', undefined],
    ['an absent field is unknown', { entries: [], total: 0 }, 'unknown', undefined],
  ])('%s', (_label, body, state, djName) => {
    const onAir = parseOnAir(body);
    expect(onAir.state).toBe(state);
    expect(onAir.state === 'dj' ? onAir.djName : undefined).toBe(djName);
  });

  it('trims a handle so formatting drift cannot split one DJ into two rows', () => {
    // Backend-Service trims on one resolution path but not the show-member
    // path, so a trailing space would otherwise open a second breakdown row.
    expect(parseOnAir({ on_air: { dj_name: ' dj pipe dreams ' } })).toEqual({ state: 'dj', djName: 'dj pipe dreams' });
  });

  it('keeps the "WXYC" station brand as a live DJ, not automation', () => {
    // Backend-Service reports the brand when an open show's DJ handle does
    // not resolve. That is a human on the air; folding it into automation
    // would erase their show from the per-DJ breakdown and inflate the
    // automation bucket with live airtime.
    expect(parseOnAir({ on_air: { dj_name: 'WXYC' } })).toEqual({ state: 'dj', djName: 'WXYC' });
  });

  it.each<[string, unknown]>([
    ['a non-JSON body', '<html>Bad Gateway</html>'],
    ['a null body', null],
    ['an array body', []],
    ['an on_air object without a name', { on_air: {} }],
    ['an on_air object with an empty name', { on_air: { dj_name: '' } }],
    ['an on_air object with a whitespace-only name', { on_air: { dj_name: '   ' } }],
    ['an on_air object with a non-string name', { on_air: { dj_name: 42 } }],
    ['an on_air string', { on_air: 'dj pipe dreams' }],
    ['an on_air array', { on_air: [{ dj_name: 'dj pipe dreams' }] }],
  ])('reads %s as unknown rather than guessing', (_label, body) => {
    // Contract drift must not mint a DJ called "undefined" or book live
    // airtime as automation; unknown is the one honest bucket.
    const onAir = parseOnAir(body);
    expect(onAir.state).toBe('unknown');
    expect(onAir.state === 'unknown' && onAir.reason.length > 0).toBe(true);
  });
});

describe('parseLatestEntryAt', () => {
  it('formats the newest entry time as a HogQL-safe UTC datetime', () => {
    // `toDateTime` inside an aggregate rejects fractional seconds and `Z`, so
    // the property is written in the same form the airtime emitter uses.
    expect(parseLatestEntryAt({ entries: [{ add_time: '2026-09-28T20:31:57.134Z' }] })).toBe('2026-09-28 20:31:57');
  });

  it.each<[string, unknown]>([
    ['no entries', { entries: [] }],
    ['no entries field', { on_air: null }],
    ['a missing add_time', { entries: [{ id: 1 }] }],
    ['an unparseable add_time', { entries: [{ add_time: 'yesterday' }] }],
    ['a non-string add_time', { entries: [{ add_time: 1759091517134 }] }],
    ['a non-object body', '<html>Bad Gateway</html>'],
  ])('omits it for %s rather than inventing one', (_label, body) => {
    expect(parseLatestEntryAt(body)).toBeUndefined();
  });
});

describe('buildCapturePayload', () => {
  const sample = sampleWxycMounts(
    statusWith([
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc.mp3', listeners: 25, listener_peak: 69 },
      { listenurl: 'http://audio-mp3.ibiblio.org:8000/wxyc-alt.mp3', listeners: 3, listener_peak: 8 },
    ])
  );
  const context = {
    apiKey: 'phc_test',
    timestamp: '2026-08-20T03:34:00.000Z',
    environment: 'production',
  };
  const payload = buildCapturePayload(
    sample,
    context,
    { state: 'dj', djName: 'dj pipe dreams' },
    '2026-09-28 20:31:57'
  );

  it('records when the newest flowsheet entry was logged', () => {
    // Lets a query spot a show that was never closed: a `dj` sample whose
    // newest entry is hours old is a missed sign-off, not a live DJ.
    expect(payload.properties.latest_entry_at).toBe('2026-09-28 20:31:57');
    expect(
      buildCapturePayload(sample, context, { state: 'automation' }, undefined).properties.latest_entry_at
    ).toBeUndefined();
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
    expect(payload.properties.unparseable_listener_counts).toBe(0);
    expect(payload.properties.environment).toBe('production');
  });

  it('carries per-mount detail without inventing per-mount property names', () => {
    expect(payload.properties.mounts).toEqual([
      { mount: 'wxyc-alt.mp3', listeners: 3, peak: 8 },
      { mount: 'wxyc.mp3', listeners: 25, peak: 69 },
    ]);
  });

  it.each<[string, OnAir, Record<string, unknown>]>([
    ['a live DJ', { state: 'dj', djName: 'dj pipe dreams' }, { on_air_state: 'dj', dj_name: 'dj pipe dreams' }],
    ['automation', { state: 'automation' }, { on_air_state: 'automation' }],
    ['unknown', { state: 'unknown', reason: 'status 503' }, { on_air_state: 'unknown' }],
  ])('records who was on the air for %s', (_label, onAir, expected) => {
    // Flat properties so station-wide per-DJ audience is a plain breakdown of
    // `total_listeners` by `dj_name`. Only a live DJ carries a name.
    const properties = buildCapturePayload(sample, context, onAir, undefined).properties;
    expect({ on_air_state: properties.on_air_state, dj_name: properties.dj_name }).toEqual({
      dj_name: undefined,
      ...expected,
    });
    // The unknown reason is for the log line, not the event schema.
    expect(properties).not.toHaveProperty('on_air_reason');
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
