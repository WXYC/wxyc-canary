/**
 * Pure parsing + payload-shaping for the WXYC stream listener sampler.
 *
 * The sampler polls ibiblio's shared Icecast `status-json.xsl` on a fixed
 * cadence and records how many people are connected to the WXYC mounts. That
 * concurrent-listener count is the streaming analogue of Nielsen's AQH
 * (Average Quarter-Hour) persons — the average number of people listening at
 * a given moment — which makes it the one online metric that can be laid
 * honestly next to a broadcast rating. Cume deliberately is NOT derived here:
 * Icecast counts connections, Nielsen counts people, and comparing the two
 * unduplicated counts is the classic apples-to-oranges error.
 *
 * Everything in this module is deliberately side-effect free so the parsing
 * rules can be tested without a network. The Lambda entry point that fetches
 * and captures lives in `stream-sampler-handler.ts`.
 */

/** Mount prefix that identifies a WXYC stream on the shared Icecast host. */
export const DEFAULT_MOUNT_PREFIX = 'wxyc';

/** The main 128kbps mount; tracked separately from the total for diagnostics. */
export const DEFAULT_PRIMARY_MOUNT = 'wxyc.mp3';

/**
 * Stable synthetic actor for every sample. PostHog requires a `distinct_id`,
 * but there is no user here — this is one server-side sampler, not a person.
 */
export const SAMPLER_DISTINCT_ID = 'wxyc-stream-sampler';

export const SAMPLE_EVENT = 'stream_listener_sample';
export const SAMPLE_FAILED_EVENT = 'stream_listener_sample_failed';

export type MountSample = {
  mount: string;
  listeners: number;
  /**
   * Icecast's `listener_peak` is cumulative since the encoder connected, not
   * a per-sample high-water mark, so it is carried for sanity-checking only —
   * never aggregate it.
   */
  peak: number | undefined;
};

export type StreamSample = {
  totalListeners: number;
  primaryListeners: number | undefined;
  mountCount: number;
  /** Sorted by mount name so successive samples diff cleanly. */
  mounts: MountSample[];
  /**
   * False when no WXYC mount is connected — a dropped encoder. This is a real
   * observation (nobody *could* be listening), which is why it produces a
   * well-formed sample rather than an error. Filter on it when averaging
   * listener counts, or the downtime zeros will drag the average down.
   */
  streamOnline: boolean;
  /**
   * How many WXYC mounts reported a listener count we could not parse. Booked
   * as 0 in the total (there is nothing better to do), but surfaced so the
   * drift is visible in the data rather than silently flattening the series.
   */
  unparseableListenerCounts: number;
};

/**
 * Who was on the air when the sample was taken, as Backend-Service's
 * paginated `GET /flowsheet` reports it in `on_air`.
 *
 * - `dj`: a human is live. `djName` may be the `"WXYC"` station brand when the
 *   open show's DJ handle does not resolve — still a live human, never
 *   automation.
 * - `automation`: `on_air` was explicitly `null`.
 * - `unknown`: the field was absent (Backend-Service's banner query failed),
 *   the read failed, or the shape drifted. `reason` says which, for the log
 *   line only — it is not an event property.
 */
export type OnAir = { state: 'dj'; djName: string } | { state: 'automation' } | { state: 'unknown'; reason: string };

export type CaptureEvent = {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
};

type PayloadContext = {
  apiKey: string;
  timestamp: string;
  environment: string;
};

/**
 * Extracts the mount basename from an Icecast `listenurl`.
 *
 * Parsing the URL rather than substring-matching the whole string matters:
 * the host (`audio-mp3.ibiblio.org`) participates in a naive `includes()`
 * check, and a future host containing the prefix would silently pull in every
 * co-tenant station on the box.
 */
export function mountPathFrom(listenurl: unknown): string | undefined {
  if (typeof listenurl !== 'string' || listenurl.length === 0) return undefined;
  try {
    const path = new URL(listenurl).pathname;
    const basename = path.split('/').filter(Boolean).pop();
    return basename && basename.length > 0 ? basename : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Icecast serialises `source` as a bare object when exactly one mount is
 * connected and as an array otherwise. Treating the object case as an array
 * yields zero mounts and a silent undercount, which for an audience metric is
 * worse than a loud failure.
 */
function normalizeSources(status: unknown): Record<string, unknown>[] {
  const icestats = (status as { icestats?: unknown } | null)?.icestats;
  const source = (icestats as { source?: unknown } | undefined)?.source;
  if (Array.isArray(source))
    return source.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null);
  if (typeof source === 'object' && source !== null) return [source as Record<string, unknown>];
  return [];
}

/**
 * Parses a listener count, accepting both numbers and numeric strings.
 *
 * Icecast builds differ in which `status-json.xsl` fields they quote, so a
 * future `"listeners":"25"` must not read as zero. That would be the worst
 * available failure: every mount would report 0 while `mounts` and
 * `stream_online: true` still looked healthy, permanently flattening the AQH
 * series with no failure event and no log signal.
 *
 * Returns `undefined` when genuinely unparseable, so the caller can count the
 * anomaly rather than silently booking a zero.
 */
function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Reduces a raw `status-json.xsl` payload to the WXYC-only sample.
 *
 * Mounts are matched by prefix rather than an exact allowlist: allowlisting
 * would undercount the day someone adds a mount, and undercounting is the
 * failure mode that silently corrupts a long time series. The discovered
 * mounts ride along in `mounts` so the drift is visible in the data itself.
 *
 * Co-tenant stations on the shared host are dropped here and never enter a
 * payload — their audience is not ours to record.
 */
export function sampleWxycMounts(
  status: unknown,
  options: { mountPrefix?: string; primaryMount?: string } = {}
): StreamSample {
  // Both sides of every comparison are lowercased. Lowercasing only the mount
  // would make `SAMPLER_MOUNT_PREFIX=WXYC` — the natural way to spell a
  // station's call letters — match nothing, emitting a well-formed
  // `total_listeners: 0` on every tick that is indistinguishable from a
  // permanently dropped encoder. That is precisely the silent undercount
  // prefix matching exists to prevent.
  const prefix = (options.mountPrefix ?? DEFAULT_MOUNT_PREFIX).toLowerCase();
  const primaryMount = (options.primaryMount ?? DEFAULT_PRIMARY_MOUNT).toLowerCase();

  const mounts: MountSample[] = [];
  let unparseableListenerCounts = 0;
  for (const source of normalizeSources(status)) {
    const mount = mountPathFrom(source.listenurl);
    if (!mount || !mount.toLowerCase().startsWith(prefix)) continue;
    const listeners = parseCount(source.listeners);
    if (listeners === undefined) unparseableListenerCounts += 1;
    mounts.push({
      mount,
      listeners: listeners ?? 0,
      peak: parseCount(source.listener_peak),
    });
  }

  mounts.sort((a, b) => a.mount.localeCompare(b.mount));

  return {
    totalListeners: mounts.reduce((sum, m) => sum + m.listeners, 0),
    primaryListeners: mounts.find((m) => m.mount.toLowerCase() === primaryMount)?.listeners,
    mountCount: mounts.length,
    mounts,
    streamOnline: mounts.length > 0,
    unparseableListenerCounts,
  };
}

/**
 * Maps a `GET /flowsheet?limit=1` body to the on-air state.
 *
 * The three documented shapes pass straight through. Anything else is
 * contract drift and reads as `unknown`: an object without a usable name must
 * not mint a DJ called "undefined", and a malformed field must not book live
 * airtime as automation.
 */
export function parseOnAir(body: unknown): OnAir {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { state: 'unknown', reason: 'flowsheet body is not a JSON object' };
  }
  if (!('on_air' in body)) return { state: 'unknown', reason: 'on_air absent' };
  const onAir = (body as { on_air: unknown }).on_air;
  if (onAir === null) return { state: 'automation' };
  if (typeof onAir === 'object' && !Array.isArray(onAir)) {
    // Trimmed because Backend-Service trims only one of its two resolution
    // paths; a stray space would otherwise split one DJ into two rows.
    const djName = (onAir as { dj_name?: unknown }).dj_name;
    const trimmed = typeof djName === 'string' ? djName.trim() : '';
    if (trimmed !== '') return { state: 'dj', djName: trimmed };
  }
  return { state: 'unknown', reason: 'on_air malformed' };
}

/**
 * Reads when the newest flowsheet entry was logged, from the one entry a
 * `GET /flowsheet?limit=1` returns.
 *
 * Recorded so a query can catch a show that was never closed: Backend-Service
 * keeps naming a DJ in `on_air` until the next show opens, so a `dj` sample
 * whose newest entry is hours old is a missed sign-off rather than a live DJ.
 * Formatted `YYYY-MM-DD HH:MM:SS` UTC because HogQL's `toDateTime` inside an
 * aggregate rejects fractional seconds and a `Z`. Anything unexpected yields
 * `undefined` — an invented time would be worse than none.
 */
export function parseLatestEntryAt(body: unknown): string | undefined {
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return undefined;
  const addTime = (entries[0] as { add_time?: unknown } | undefined)?.add_time;
  if (typeof addTime !== 'string') return undefined;
  const parsed = new Date(addTime);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Shapes one PostHog capture event per sample.
 *
 * One summary event per tick — never one per mount — keeps the ingestion cost
 * pinned at a constant 288/day on the 5-minute schedule regardless of how
 * many mounts ibiblio exposes. Per-mount events would make a billing-relevant
 * number depend on upstream config we do not control, which is the shape that
 * caused the 2026-08-04 org-wide quota cutoff.
 */
export function buildCapturePayload(
  sample: StreamSample,
  context: PayloadContext,
  onAir: OnAir,
  latestEntryAt: string | undefined
): CaptureEvent {
  return {
    api_key: context.apiKey,
    event: SAMPLE_EVENT,
    distinct_id: SAMPLER_DISTINCT_ID,
    timestamp: context.timestamp,
    properties: {
      // Flat numerics first: these are what a trends insight charts directly.
      total_listeners: sample.totalListeners,
      primary_listeners: sample.primaryListeners,
      mount_count: sample.mountCount,
      stream_online: sample.streamOnline,
      unparseable_listener_counts: sample.unparseableListenerCounts,
      // Per-mount detail as a nested array rather than synthesised property
      // names (`listeners_wxyc_mp3`), which would fragment the schema every
      // time a mount is renamed.
      mounts: sample.mounts,
      // Flat, so station-wide per-DJ audience is a breakdown of
      // `total_listeners` by `dj_name` rather than a separate pipeline.
      on_air_state: onAir.state,
      dj_name: onAir.state === 'dj' ? onAir.djName : undefined,
      latest_entry_at: latestEntryAt,
      environment: context.environment,
      source: 'icecast',
      // No person behind a server-side sampler; skip profile processing.
      $process_person_profile: false,
    },
  };
}

/**
 * Shapes the failure event.
 *
 * A failed fetch deliberately does NOT emit `total_listeners: 0`. Zero is a
 * meaningful value for this metric (an idle stream), so a transport failure
 * recorded as zero would quietly drag the average down and be invisible at
 * query time. A separate event name keeps "we could not measure" and "we
 * measured nobody" distinguishable forever.
 */
export function buildFailurePayload(context: PayloadContext & { reason: string }): CaptureEvent {
  return {
    api_key: context.apiKey,
    event: SAMPLE_FAILED_EVENT,
    distinct_id: SAMPLER_DISTINCT_ID,
    timestamp: context.timestamp,
    properties: {
      reason: context.reason,
      environment: context.environment,
      source: 'icecast',
      $process_person_profile: false,
    },
  };
}
