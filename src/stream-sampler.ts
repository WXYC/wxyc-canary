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
};

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

/** Icecast occasionally omits `listeners` mid-reconnect; treat anything non-numeric as 0. */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toOptionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  const prefix = options.mountPrefix ?? DEFAULT_MOUNT_PREFIX;
  const primaryMount = options.primaryMount ?? DEFAULT_PRIMARY_MOUNT;

  const mounts: MountSample[] = [];
  for (const source of normalizeSources(status)) {
    const mount = mountPathFrom(source.listenurl);
    if (!mount || !mount.toLowerCase().startsWith(prefix)) continue;
    mounts.push({
      mount,
      listeners: toCount(source.listeners),
      peak: toOptionalCount(source.listener_peak),
    });
  }

  mounts.sort((a, b) => a.mount.localeCompare(b.mount));

  return {
    totalListeners: mounts.reduce((sum, m) => sum + m.listeners, 0),
    primaryListeners: mounts.find((m) => m.mount === primaryMount)?.listeners,
    mountCount: mounts.length,
    mounts,
    streamOnline: mounts.length > 0,
  };
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
export function buildCapturePayload(sample: StreamSample, context: PayloadContext): CaptureEvent {
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
      // Per-mount detail as a nested array rather than synthesised property
      // names (`listeners_wxyc_mp3`), which would fragment the schema every
      // time a mount is renamed.
      mounts: sample.mounts,
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
