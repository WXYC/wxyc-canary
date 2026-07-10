import { createHash, randomBytes } from 'node:crypto';
import { canaryFetch } from './client.js';
import type { Check, OidcProbe } from './types.js';

/**
 * OIDC code + PKCE authorize probe (wxyc-canary#60). Extracted from
 * `src/checks.ts` under wxyc-canary#62: the check itself is materially larger
 * than the sibling proxy/DJ probes (PKCE helper, dual-shape redactor,
 * normalized origin+pathname compare, half a dozen fail branches), so it lives
 * in its own module to restore `checks.ts`'s read-at-altitude property. The
 * exported constant is dropped into the `checks` array in `checks.ts`
 * unchanged.
 *
 * Load-bearing shapes preserved in the split (see wxyc-canary#61 review
 * rounds 1-3 for the origin of each):
 *
 *  - `generatePkcePair` (module-private): the verifier is deliberately NOT
 *    returned. The probe stops at the 302 and never exchanges the code, so
 *    the verifier's only role is sha256 input; leaking it via the return type
 *    would defeat PKCE's point (see R2).
 *  - `redactCodeAndState` (module-private): URL-shape AND JSON-shape
 *    redaction, with negative lookbehind guards and a terminator class that
 *    preserves downstream OIDC routing signals (`error=access_denied`,
 *    `oauthConsent` breadcrumb for BS#1571). Every diagnostic-carrying
 *    branch in `run` funnels through this ONE helper — a per-call arrow
 *    would re-create every tick and silently drift.
 *  - `normalizePath` (module-private): strips ALL trailing slashes (not one)
 *    so `/authorize-echo//` collapses to `/authorize-echo`, and preserves
 *    the root path via `|| '/'`. The origin comparison downstream is on
 *    `URL#origin` (host + scheme + port), so the prefix-bypass guard is
 *    unaffected.
 *  - Strict origin + pathname compare (never `startsWith`): rejects the
 *    class of Locations like
 *      https://canary.wxyc.org/authorize-echo-attacker.example.com/?code=X
 *    that a naive prefix match would accept (see wxyc-canary#61 F1).
 */

/**
 * Generate a fresh PKCE `code_challenge` per RFC 7636 §4. The verifier is
 * 32 random bytes rendered as urlsafe base64 (43 chars with the padding
 * stripped); the challenge is `base64url(sha256(verifier))`. Node's
 * `randomBytes` is a CSPRNG; the verifier lives for the duration of a
 * single `oidc-authorize` tick and never leaves the process, so any
 * weaker source would already be over-engineered for a canary that
 * doesn't exchange the code.
 *
 * The verifier itself is intentionally NOT returned — the check stops at
 * the /authorize 302 and never exchanges the code, so the verifier's
 * only role is as sha256 input. Returning it would create a call-site
 * temptation to log or reuse it, both of which would defeat the point of
 * PKCE. If a future rev grows a second-tier probe that exchanges the code
 * with a WRONG verifier (to prove the exchange rejects it), that probe
 * should generate its own pair rather than get one leaked back through
 * this helper's return type.
 */
function generatePkcePair(): { challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { challenge };
}

/**
 * Redact the two OIDC secret-adjacent tokens (`code` and `state`) from a
 * string that's about to land in an operator-visible alert. Applied to
 * every diagnostic-carrying string this check emits — 5xx body slices,
 * unexpected-status body slices, `Location` values on the mismatch and
 * missing-code branches, unparseable-Location slices. Both `code` and
 * `state` are covered: `code` is a short-lived but real single-use OAuth
 * credential; `state` is the CSRF barrier — the mismatch branch prints
 * only the mismatch fact, never the returned value, and every sibling
 * error branch must uphold that invariant even when the raw body carries
 * the value.
 *
 * Two shapes are covered because the same value can appear in either a URL
 * query string OR a JSON envelope (better-auth 5xx bodies are JSON):
 *
 *   URL form:  `code=abcd1234`, `state=xyz`
 *              (also matches URL fragments — `#code=abcd1234` — because
 *              the `=` separator is identical to a query-string parameter)
 *   JSON form: strictly quoted-key form only — `"code":"abcd1234"`,
 *              `"state":"xyz"`. Structurally rules out identifier-adjacent
 *              substrings (`errorCode`, `statusCode`, `session_state`,
 *              `oauthConsent`) since those don't have the closing quote
 *              right after `code`/`state`. Ruling those out matters: the
 *              5xx branch's docstring explicitly promises to preserve
 *              `oauthConsent` for BS#1571 routing. Requiring a quoted key
 *              also structurally can't match URL-shape input (which never
 *              has quoted keys), so the URL pass and JSON pass never
 *              double-fire on the same substring.
 *
 * URL-form regexes carry two guards not obvious at a glance:
 *
 *  - Terminator class `[^&\s"'<>,;#]+` includes `&` so the greedy match
 *    stops at the next URL param (without `&`,
 *    `code=<redacted>&scope=openid&…` would swallow the whole tail after
 *    the URL pass placeholder, destroying every downstream OIDC routing
 *    signal like `error=…`); includes `<`/`>` so HTML-ish 5xx envelopes
 *    (`<b>code=REAL</b>`) can't hide the value behind a tag; and includes
 *    `,` / `;` / `#` (wxyc-canary#68 R4-3) so a comma / semicolon / URL
 *    fragment terminator preserves downstream diagnostics. `#` is the
 *    most load-bearing of the three: an OIDC error response like
 *    `#code=X&error=access_denied` MUST not lose the `error=access_denied`
 *    routing signal to a greedy match.
 *  - Negative lookbehind `(?<![-A-Za-z0-9_])` prevents substring matches
 *    on identifiers whose tail happens to be `code`/`state` (`errorcode=`,
 *    `session_state=`, `oauth-code=` — the hyphen-prefixed form is
 *    covered by wxyc-canary#68 R4-1). Same rationale as the quoted-key
 *    JSON form: preserve identifier-shaped breadcrumbs for on-call
 *    routing.
 *
 * JSON-form value class `(?:\\.|[^"])+` (wxyc-canary#68 R4-2) handles
 * escaped quotes inside the value — a body like `{"code":"abc\"def"}`
 * previously terminated the match at the first `\"`, leaving `def"`
 * exposed. The `\\.` alternative consumes any escaped char (including a
 * literal backslash) and `[^"]` consumes any non-quote — together they
 * span the whole JSON-string value without stopping at an escaped quote.
 *
 * Hoisted to module scope so every branch that formats an error message
 * uses the same redaction — a per-call arrow function inside `run` would
 * be re-created every tick and drift silently if a future error branch
 * called its own inline redactor.
 */
const redactCodeAndState = (s: string): string =>
  s
    // URL-shape: `code=<value>` / `state=<value>`. See the docstring above
    // for the terminator + lookbehind rationale. Negative lookbehind
    // includes `-` (wxyc-canary#68 R4-1) so `oauth-code=REAL` is treated
    // as identifier-shaped, not `code=`. Terminator includes `,`, `;`, `#`
    // (wxyc-canary#68 R4-3) so a comma / semicolon / fragment doesn't
    // swallow the tail.
    .replace(/(?<![-A-Za-z0-9_])code=[^&\s"'<>,;#]+/g, 'code=<redacted>')
    .replace(/(?<![-A-Za-z0-9_])state=[^&\s"'<>,;#]+/g, 'state=<redacted>')
    // JSON-shape: strictly `"code":"<value>"` / `"state":"<value>"`. The
    // closing quote after `code`/`state` structurally rules out matches on
    // `"errorCode":`, `"statusCode":`, `"session_state":`, `"oauthConsent":`
    // — which is load-bearing: the BS#1571 5xx branch promises to preserve
    // `oauthConsent` as a routing breadcrumb. Case-insensitive because
    // JSON keys are conventionally lowercase but nothing forbids `Code`
    // or `State`. Whitespace tolerance around `:` matches pretty-printed
    // envelopes. Value class `(?:\\.|[^"])+` (wxyc-canary#68 R4-2) spans
    // escaped quotes so `{"code":"abc\"def"}` doesn't leave `def"`
    // exposed at the first escape.
    .replace(/("code"\s*:\s*")(?:\\.|[^"])+"/gi, '$1<redacted>"')
    .replace(/("state"\s*:\s*")(?:\\.|[^"])+"/gi, '$1<redacted>"');

/**
 * Normalize a URL pathname so `/authorize-echo`, `/authorize-echo/`, and
 * `/authorize-echo//` all compare equal — trailing-slash tolerance only.
 * This is a NARROWER normalization than RFC 3986 §6.2.3 (Scheme-Based
 * Normalization), which covers additional equivalences like
 * percent-encoding case-folding and empty-path-to-`/` (see wxyc-canary#68
 * R4-4): those extra equivalences are deliberately OUT OF SCOPE here
 * because the operator failure mode this helper exists for is a slash-
 * count drift between the trusted-client registration and the CFN
 * `OidcProbeRedirectUri` param. Widening to full RFC 3986 §6.2.3
 * would require decoding percent-encoded sequences before the compare —
 * and no known operator gap on this path emits `%2F`, so that's YAGNI.
 *
 * Strips ALL trailing slashes rather than one so a `base + '/' + path`
 * concatenation bug on either side that produces `//` still compares
 * equal. The `|| '/'` fallback preserves the root path so an
 * `/`-only-configured redirect URI doesn't collapse to empty and start
 * accidentally matching every other Location. The subdomain /
 * prefix-bypass guard is unaffected because it lives on `origin`, not
 * pathname.
 *
 * Hoisted to module scope for the same reason as `redactCodeAndState`
 * (see its docstring): a per-tick arrow function inside `run` re-creates
 * on every tick and drifts silently if a future error branch grows its
 * own inline normalizer.
 */
const normalizePath = (p: string): string => p.replace(/\/+$/, '') || '/';

/**
 * OIDC code + PKCE authorize probe. The load-bearing check that would have
 * caught WXYC/Backend-Service#1571 — the `oauthConsent` schema-drift 500 —
 * before the flowsheet-digitization verifier tripped over it in production.
 * Every future OIDC client (WikiJS, additional in-house tools) rides on the
 * same authorize path, so a regression here is a login-broken-for-everyone
 * outage that's invisible to the existing DJ-bearer/proxy/healthcheck
 * probes.
 *
 * Uses a DEDICATED `wxyc-canary` PUBLIC trusted client (registered in
 * WXYC/Backend-Service#1576). Public client + PKCE means no `client_secret`
 * lives in the canary env — the probe stops at the 302, never exchanges
 * the code, and a leaked canary env carries no OIDC credential.
 *
 * Multi-probe shape (wxyc-canary#63): `ctx.oidcProbes` is a non-empty
 * readonly tuple of `(clientId, redirectUri, label)` triples. Today the
 * env loader always produces exactly one probe (the `wxyc-canary` trusted
 * client), so the loop runs once and behaves identically to the single-
 * client shape it replaced. When a second consumer registers (WikiJS,
 * in-house tools), the env loader can widen the tuple and any per-client
 * regression surfaces with the failing probe's `label` in the error
 * message. The check does not short-circuit on the first failing probe —
 * every probe runs so a single tick catches multi-client damage in one
 * alarm rather than N.
 *
 * Contract (each tick, per probe):
 *   1. Reuse the session token from `signInDj` (available on the `signed-in`
 *      narrowing of `ctx.djAuth` as `ctx.djAuth.sessionToken` — wxyc-canary#65).
 *   2. GET `/auth/oauth2/authorize?response_type=code&client_id=<probe>
 *      &redirect_uri=<probe-callback>&scope=openid+profile+email
 *      &state=<random>&code_challenge=<S256(v)>&code_challenge_method=S256`
 *      with `Authorization: Bearer <session-token>` (the better-auth
 *      `bearer` plugin translates it to a session cookie) and
 *      `redirect: 'manual'` (so we can inspect the 3xx Location).
 *   3. Assert 302 or 303 (OAuth 2.0 §4.1.2 does not pin the code), Location
 *      matches the probe redirect URI on both `origin` and `pathname`
 *      (strict URL parse — never a `startsWith` on the raw string, which
 *      accepts `https://canary.wxyc.org/authorize-echo-attacker.example.com`
 *      as valid), has a non-empty `code` query param, and echoes the
 *      `state` we sent. A relative Location (RFC 7231 §7.1.2) is
 *      resolved against the request URL before the compare — better-auth
 *      does not emit relative Locations today, but a future rev or a
 *      fronting proxy that rewrites them would otherwise fail with a
 *      misleading "not a valid URL" against a spec-compliant response
 *      (see wxyc-canary#66). Origin+pathname compare downstream still
 *      enforces the exact match, so RFC compliance does not weaken the
 *      anti-prefix-bypass guard.
 *
 * Fails on: non-302/303, missing/mismatched state, missing code, Location
 * pointing at a login page or crafted redirect (session invalidated), 5xx,
 * or the exact BS#1571 500 shape. Message truncates to the first 200 chars
 * of body per `healthcheck`'s convention, and runs `redactCodeAndState`
 * against every diagnostic string it emits (5xx and non-3xx body slices,
 * `Location` values on the mismatch and missing-code branches, the
 * unparseable-Location slice). That helper covers both URL-shape
 * (`code=…&state=…`) and JSON-shape (`"code":"…"` / `"state":"…"`)
 * because better-auth 5xx bodies are JSON envelopes; see its own
 * docstring for the exact matching rules. The Set-Cookie header is
 * session-material for the canary DJ and is likewise never logged.
 */
export const oidcAuthorize: Check = {
  name: 'oidc-authorize',
  description:
    'GET /auth/oauth2/authorize with PKCE — catches BS#1571 oauthConsent-500 and every OIDC login-broken regression',
  requiresAuth: true,
  suites: ['smoke'],
  // Default paging tier. Login is a DJ-on-air surface — every OIDC client
  // (flowsheet verifier today, WikiJS + others planned) breaks when this
  // path breaks.
  run: async (ctx) => {
    if (ctx.djAuth.kind !== 'signed-in') {
      // Belt-and-suspenders: the auth-precondition layer already downgrades
      // the check to `fail` when sign-in errored. This branch fires only if
      // the runner dispatches a `requiresAuth: true` check with a
      // non-signed-in `djAuth` — a shape rev we want a clear message on,
      // not a confusing "cannot read properties of undefined." Same string
      // shape as the pre-#65 `if (!ctx.djSessionToken)` guard emitted so
      // alert-message regexes in downstream tests continue to match.
      throw new Error('DJ session token missing (signInDj did not return sessionToken)');
    }
    const sessionToken = ctx.djAuth.sessionToken;
    // Multi-probe loop (wxyc-canary#63). `ctx.oidcProbes` is a non-empty
    // tuple; run every probe and collect its failure. Multi-client damage
    // (one client's trusted-client registration missing while others
    // survive) surfaces with the failing probe's `label` prefixed on the
    // message so on-call routes to the right owner rather than "OIDC is
    // broken." The check does NOT short-circuit on the first failing
    // probe — one tick catches multi-client damage in one alarm.
    const failures: string[] = [];
    for (const probe of ctx.oidcProbes) {
      try {
        await runOneProbe(ctx.authUrl, probe, sessionToken);
      } catch (err) {
        failures.push(`[${probe.label}] ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      // Join with ` | ` so a multi-client failure fans into a single alert
      // message; the `[label]` prefixes on each failure preserve routing.
      throw new Error(failures.join(' | '));
    }
    // Success: don't publish `EnrichmentLagSeconds`-style metrics — this
    // check's cost signal is `CheckLatency` (already emitted per-check by
    // the runner), and there's no domain-meaningful duration to surface.
  },
};

/**
 * Execute one authorize probe against `authUrl` for the given
 * `(clientId, redirectUri, label)` triple. Throws on any failure — the
 * caller (the `run` loop above) prefixes the message with `[label]` and
 * aggregates across probes. Extracted from `run` so the multi-probe loop
 * reads at altitude and the per-probe fail cascade stays testable
 * against a single probe in isolation.
 */
async function runOneProbe(authUrl: string, probe: OidcProbe, sessionToken: string): Promise<void> {
  const { challenge } = generatePkcePair();
  // 16 random bytes → 22-char urlsafe base64. Long enough that a
  // collision within a single tick is astronomical; short enough not to
  // stuff the query string.
  const state = randomBytes(16).toString('base64url');
  // Strip trailing slashes on `authUrl` before path concat so an operator who
  // sets `CANARY_AUTH_URL=https://api.wxyc.org/auth/` (trailing slash from a
  // browser copy-paste) doesn't compose `//oauth2/authorize`. better-auth's
  // router treats the double-slash as a distinct route → 404 → the canary
  // pages on-call for a config typo instead of a real regression. Uses the
  // same regex + `|| '/'` shape as `normalizePath` above so a same-file
  // consumer can't drift.
  const url = new URL(`${authUrl.replace(/\/+$/, '')}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', probe.clientId);
  url.searchParams.set('redirect_uri', probe.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const r = await canaryFetch(url.toString(), {
    headers: { Authorization: `Bearer ${sessionToken}` },
    redirect: 'manual',
  });

  // A 5xx here is the BS#1571 replay surface: `oauthConsent` schema
  // missing from the Drizzle adapter map → 500. Distinct routing from
  // the 302-but-wrong-Location cases below (that's a login-page bounce,
  // not a substrate-missing error). Include the response body truncation
  // per healthcheck's convention.
  //
  // Redact `code` and `state` before slicing — a 5xx body from a
  // partially-executed authorize handler could contain the code the
  // handler minted just before the 5xx (better-auth today doesn't, but
  // a future rev might, and the docstring promises "never logs the
  // code" without qualification). The redactor covers both URL form
  // (`code=…`) and JSON form (`"code":"…"`) because better-auth 5xx
  // bodies are JSON envelopes. The redaction is body-first + slice so
  // the token can't survive at a truncation boundary.
  if (r.status >= 500) {
    throw new Error(
      `authorize expected 302, got ${r.status} (BS#1571 replay class if body mentions oauthConsent): ${redactCodeAndState(r.rawText).slice(0, 200)}`
    );
  }
  // OAuth 2.0 (RFC 6749 §4.1.2) allows either 302 Found or 303 See Other
  // on the authorization response. better-auth returns 302 today, but the
  // spec doesn't pin it — a future rev switching to 303 would be a
  // legitimate change we must not flap on.
  if (r.status !== 302 && r.status !== 303) {
    throw new Error(`authorize expected 302, got ${r.status}: ${redactCodeAndState(r.rawText).slice(0, 200)}`);
  }

  const location = r.location;
  if (!location) {
    // 3xx without a Location header is malformed. `FetchResult.location`
    // is the typed accessor over `headers.location` (canaryFetch
    // lowercases on the way out), so this covers `Location:` too.
    // Reading through the accessor instead of `headers?.location` means
    // a call-site can't type `headers?.Location` (title-case) and
    // silently read `undefined` — see wxyc-canary#64.
    throw new Error(`authorize returned ${r.status} with no Location header`);
  }

  let parsed: URL;
  try {
    // RFC 7231 §7.1.2 permits a relative `Location`; the client MUST
    // resolve it against the request URL. Passing `url` (the
    // authorize-endpoint request URL) as the base makes both
    // `/authorize-echo?code=…` (relative) and
    // `https://canary.wxyc.org/authorize-echo?code=…` (absolute) parse
    // through this single call — an absolute URL ignores the base, a
    // relative one resolves. The origin+pathname compare downstream
    // still enforces the exact match against `probe.redirectUri`, so
    // RFC compliance does not weaken the anti-prefix-bypass guard.
    // See wxyc-canary#66.
    parsed = new URL(location, url);
  } catch {
    throw new Error(`authorize 302 Location is not a valid URL: ${redactCodeAndState(location).slice(0, 200)}`);
  }
  // Login-page bounce or crafted-redirect regression: strict origin +
  // pathname comparison rejects both a login-page URL AND the class of
  // prefix-bypass Locations like
  //   https://canary.wxyc.org/authorize-echo-attacker.example.com/?code=X
  // that a naive `location.startsWith(probe.redirectUri)` would
  // accept. Parse both sides — origin + pathname compare — so the guard
  // holds regardless of how the Location is stringified (trailing slash,
  // extra path segment, subdomain injection). Distinct message so the
  // on-call routes to session/auth investigation.
  let expected: URL;
  try {
    expected = new URL(probe.redirectUri);
  } catch {
    // Should never fire — config-time validation of the redirect URI
    // is out of scope for the runtime check. Fail loudly if it happens.
    throw new Error(
      `oidcProbeRedirectUri is not a valid URL — configuration error: ${probe.redirectUri.slice(0, 200)}`
    );
  }
  // Normalize trailing slashes on both sides before compare — see
  // `normalizePath` for the RFC citation + why we strip ALL of them
  // instead of one. Origin still contains the host, so the
  // subdomain-injection guard is untouched.
  if (parsed.origin !== expected.origin || normalizePath(parsed.pathname) !== normalizePath(expected.pathname)) {
    throw new Error(
      `authorize 302 Location does not match the probe redirect URI origin+path (session invalidated, trusted client missing, or redirect regression): ${redactCodeAndState(location).slice(0, 200)}`
    );
  }
  const returnedCode = parsed.searchParams.get('code');
  if (!returnedCode) {
    // Wrap in `redactCodeAndState` to match sibling error branches. A
    // fragment-form Location like
    //   https://canary.wxyc.org/authorize-echo#code=REAL-CODE&state=X
    // slips past the origin+pathname compare (fragments live in the URL
    // hash, not the pathname) and `searchParams.get('code')` returns null
    // (fragments aren't parsed as query). Without redaction, the raw
    // fragment lands in the alert — direct violation of the docstring
    // "never logs the code" promise.
    throw new Error(
      `authorize 302 Location has no code query param (better-auth issued a bare redirect instead of a code): ${redactCodeAndState(location).slice(0, 200)}`
    );
  }
  const returnedState = parsed.searchParams.get('state');
  if (returnedState !== state) {
    // CSRF barrier: the server MUST echo the state we sent. If it echoes
    // something else — attacker fix, cross-tab pollution, better-auth
    // regression — pages. We can't log the returned state either (it
    // could carry canary-private info in a future rev); log only that
    // it mismatched.
    throw new Error('authorize 302 Location state does not match the state the check sent');
  }
}
