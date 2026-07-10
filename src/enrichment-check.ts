import { canaryFetch } from './client.js';
import type { CheckContext, CheckResult } from './types.js';

/**
 * Sentinel column values the check writes into the flowsheet. Tagged with a
 * per-invocation timestamp so concurrent canary runs (e.g. an overlap during
 * a Lambda cold start) don't try to enrich each other's rows, and so a row
 * left behind by a failed cleanup is recognizable as such. The artist-name
 * prefix is intentionally not a real artist — `WXYCCanary-` won't ever
 * appear in the `@wxyc/shared` example-data canonical list, and it's the
 * filter operators use to scrub canary debris from public archives.
 */
const SENTINEL_PREFIX = 'WXYCCanary';
const SENTINEL_ALBUM = 'WXYCCanary';
const SENTINEL_LABEL = 'WXYCCanary';

/**
 * Shape of the row returned by GET /flowsheet?start_id=&end_id=. The V2
 * transform flattens `metadata.youtube_music_url` to a top-level field
 * (see Backend-Service `transformToV2`) — only the fields the canary
 * inspects are typed here.
 */
type V2FlowsheetTrackEntry = {
  id: number;
  entry_type?: string;
  youtube_music_url?: string | null;
};

/**
 * Insert a sentinel flowsheet row, poll until LML enrichment populates
 * `youtube_music_url` (the synthesized-URL catch-arm guarantees this for
 * any successful path; see BS#873), then delete the row and end the show.
 *
 * Behavior:
 *   - If another DJ owns the active show: returns a skipped CheckResult.
 *     The canary deliberately does not insert into a real DJ's show.
 *   - If no active show: starts one with the canary DJ.
 *   - If the active show is the canary DJ's own (left over from a previous
 *     run that crashed mid-cleanup): reuses it.
 *
 * Cleanup is best-effort: a `finally` block deletes the row and ends the
 * show whether the polling succeeded, timed out, or threw. Cleanup errors
 * are logged but don't override the primary failure — if polling failed,
 * the operator sees the polling error first, not the cleanup error.
 *
 * Returns `{ metrics: { EnrichmentLagSeconds: N } }` on success, or a
 * `{ skipped: true, skipReason }` on the other-DJ case.
 */
export async function runEnrichmentCheck(ctx: CheckContext): Promise<CheckResult> {
  // Narrow via the discriminated `djAuth` union (wxyc-canary#65). The
  // runner already downgrades a non-signed-in dispatch to `fail` before
  // reaching here; the throw preserves the pre-#65 belt-and-suspenders
  // safety so future refactors can't silently bypass the auth check.
  if (ctx.djAuth.kind !== 'signed-in') throw new Error('DJ bearer token missing');
  const { jwt, userId } = ctx.djAuth;
  // `userId` is the one field the write canary can't tolerate absent —
  // the /flowsheet/join and /flowsheet/end endpoints both require it in
  // the request body. Read-only DJ-auth checks tolerate a missing userId
  // (better-auth response-shape drift), but this write path fails loud.
  if (!userId) throw new Error('DJ user id missing');

  const auth = { Authorization: `Bearer ${jwt}` };
  const jsonAuth = { ...auth, 'Content-Type': 'application/json' };
  const sentinelTs = Date.now();
  const artistName = `${SENTINEL_PREFIX}-${sentinelTs}`;
  const trackTitle = `Sentinel-${sentinelTs}`;

  // 1. Don't write into a real DJ's show.
  const djsOnAir = await canaryFetch(`${ctx.backendUrl}/flowsheet/djs-on-air`, { headers: auth });
  if (!djsOnAir.ok) {
    throw new Error(`djs-on-air precondition failed with ${djsOnAir.status}: ${djsOnAir.rawText.slice(0, 200)}`);
  }
  const djs = Array.isArray(djsOnAir.body) ? (djsOnAir.body as Array<{ id: string | null }>) : [];
  const otherDjActive = djs.length > 0 && !djs.some((d) => d.id === userId);
  if (otherDjActive) {
    const otherIds = djs.map((d) => d.id ?? '<null>').join(',');
    return { skipped: true, skipReason: `other DJ on-air (ids=${otherIds}); not writing sentinel` };
  }

  // 2. Join the show. The /flowsheet/join controller starts a new show if
  //    there's no active one, or adds the DJ to the existing one. Either
  //    way, addEntry will pass showMemberMiddleware afterwards.
  const joinResp = await canaryFetch(`${ctx.backendUrl}/flowsheet/join`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ dj_id: userId, show_name: 'WXYC Canary Probe' }),
  });
  if (!joinResp.ok) {
    throw new Error(`flowsheet/join failed with ${joinResp.status}: ${joinResp.rawText.slice(0, 200)}`);
  }

  // 3. Insert the sentinel row. Free-form (no album_id) — this is the
  //    branch that fires fireAndForgetMetadata + fireAndForgetLinkage,
  //    which is exactly the enrichment path the 2026-05-13 regression
  //    broke.
  const insertResp = await canaryFetch(`${ctx.backendUrl}/flowsheet`, {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({
      artist_name: artistName,
      album_title: SENTINEL_ALBUM,
      track_title: trackTitle,
      record_label: SENTINEL_LABEL,
    }),
  });

  let insertedId: number | undefined;
  let lagSeconds: number | undefined;

  try {
    if (!insertResp.ok) {
      throw new Error(`flowsheet insert failed with ${insertResp.status}: ${insertResp.rawText.slice(0, 200)}`);
    }
    const insertBody = insertResp.body as { id?: number };
    if (!insertBody || typeof insertBody.id !== 'number') {
      throw new Error(`flowsheet insert returned no id: ${insertResp.rawText.slice(0, 200)}`);
    }
    insertedId = insertBody.id;
    // Start the enrichment-lag clock *after* the row is committed in BS.
    // The metric is the time-from-insert-visible to enrichment-fields-
    // populated, not the canary's own POST round-trip. Threshold in
    // template.yaml is calibrated against the BS fire-and-forget budget.
    const insertConfirmedAt = performance.now();

    // 4. Poll the row range until the row's youtube_music_url is populated.
    //    `?start_id=N-1&end_id=N+1` matches the row exactly (range endpoint
    //    is inclusive in the controller). 404 ("No Tracks found") is treated
    //    as transient — the row was just inserted and may not be visible to
    //    a follow-up read for a millisecond or two.
    const pollDeadline = performance.now() + ctx.enrichmentPollTimeoutMs;
    while (performance.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, ctx.enrichmentPollIntervalMs));
      const pollResp = await canaryFetch(
        `${ctx.backendUrl}/flowsheet?start_id=${insertedId - 1}&end_id=${insertedId + 1}`,
        { headers: auth }
      );
      if (pollResp.status === 404) continue;
      if (!pollResp.ok) {
        throw new Error(`flowsheet poll failed with ${pollResp.status}: ${pollResp.rawText.slice(0, 200)}`);
      }
      const entries = Array.isArray(pollResp.body) ? (pollResp.body as V2FlowsheetTrackEntry[]) : [];
      const row = entries.find((e) => e.id === insertedId);
      if (row?.youtube_music_url) {
        lagSeconds = (performance.now() - insertConfirmedAt) / 1000;
        break;
      }
    }

    if (lagSeconds === undefined) {
      throw new Error(
        `enrichment did not populate youtube_music_url within ${ctx.enrichmentPollTimeoutMs}ms (sentinel id=${insertedId})`
      );
    }
  } finally {
    // 5. Best-effort cleanup. Delete the row first (so even if endShow
    //    fails we don't leak sentinel rows), then end the show. Failures
    //    here are logged but never override the primary throw.
    if (insertedId !== undefined) {
      try {
        const delResp = await canaryFetch(`${ctx.backendUrl}/flowsheet`, {
          method: 'DELETE',
          headers: jsonAuth,
          body: JSON.stringify({ entry_id: insertedId }),
        });
        if (!delResp.ok) {
          console.warn(
            `[enrichment-check] cleanup delete failed for sentinel id=${insertedId}: ${delResp.status} ${delResp.rawText.slice(0, 200)}`
          );
        }
      } catch (err) {
        console.warn(
          `[enrichment-check] cleanup delete threw for sentinel id=${insertedId}: ${(err as Error).message}`
        );
      }
    }
    // End the show unconditionally. The djs-on-air precondition at step 1
    // guarantees that if anyone is on-air now, it's the canary DJ — either
    // because we joined a fresh show or because a previous canary run
    // crashed mid-cleanup and left its show open. In both cases the
    // canary owns the show; the previous "only end if we started it"
    // gating leaked the show indefinitely across runs.
    try {
      const endResp = await canaryFetch(`${ctx.backendUrl}/flowsheet/end`, {
        method: 'POST',
        headers: jsonAuth,
        body: JSON.stringify({ dj_id: userId }),
      });
      if (!endResp.ok) {
        console.warn(`[enrichment-check] cleanup end-show failed: ${endResp.status} ${endResp.rawText.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[enrichment-check] cleanup end-show threw: ${(err as Error).message}`);
    }
  }

  return { metrics: { EnrichmentLagSeconds: lagSeconds } };
}
