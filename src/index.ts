interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * Chronicling America MCP — full-text search of ~150 years of digitized U.S.
 * newspapers (1690s–present) from the Library of Congress.
 *
 * Source: the LoC JSON API (loc.gov/collections/chronicling-america, keyless).
 * The classic chroniclingamerica.loc.gov/search API was retired (404/redirect);
 * this uses the current loc.gov endpoint with `fo=json`.
 *
 * Complements the `trove` pack (Australian historic newspapers) with the U.S.
 * corpus. Tool: search_newspapers.
 *
 * SEARCH IS NOT DEAD, IT IS A LOTTERY (fleet #2708 called it 100% dead on
 * 2026-10-06; reproduced live again 2026-10-17 for fleet #3246 and it is not
 * — it is a bot/WAF rule that lets a small, roughly constant fraction of `q=`
 * requests through and either 403s fast or hangs with zero bytes back on the
 * rest). 30-day Analytics Engine numbers for this pack: 8 success / 137 calls
 * (5.8%), close to the 8.3% fleet #3246 was filed against. A live sample of 10
 * single-shot FRESH (uncached) queries during the #3246 fix reproduced exactly
 * that shape: 1 success, 9 timeouts. Browsing the same collection WITHOUT a
 * search term (`fo=json` alone) still returns 200 every time, so it is not a
 * site-wide outage, and there is no working alternate endpoint: the legacy
 * chroniclingamerica.loc.gov host redirects to a path that 404s, and
 * /search/?fa=partof:chronicling+america 302s straight back to this same
 * collections/chronicling-america endpoint. So the only lever available is
 * trying more than once per call — see `MAX_ATTEMPTS` below — which is
 * grounded in a real observation, not a hope: during the #3246 reproduction,
 * a query that timed out on attempt 1 (15s, zero bytes) came back with 707
 * real matches on attempt 2, fired immediately after with no deliberate delay.
 * Each attempt is independent against the same WAF, so retrying trades wall
 * time for a materially better cumulative hit rate (roughly 1-(1-p)^n for a
 * per-attempt rate p of ~6-10%) without touching anything LoC-side.
 *
 * MISCLASSIFICATION THIS FIXES: the stuck-class check saw failures whose
 * recorded `sources` host was pqauisounztsgdgfkhke.supabase.co (our Supabase
 * project) and read that as "our own Postgres is 500ing" — this pack holds no
 * database table and runs no query at all. That host is only the egress
 * RELAY's own URL (locFetch below routes through it when the gateway injects
 * _proxyUrl/_proxyToken, because loc.gov 403s CF egress on every UA);
 * `workers/gateway/src/upstream-capture.ts` records the
 * literal fetch target by design, so any relay-routed pack's failure always
 * shows the relay's host, never the real upstream. The genuine ownership
 * split that matters is handled below: a failure that never reached LoC at
 * all (the relay's own synthesized 400/401/403/405 — a dead token, a host
 * dropped from its allow-list) is marked ours via markInternalOrigin; a
 * response or hang that did reach loc.gov, however LoC answered, stays theirs.
 */

import { LocalStoreError, normalizeState, pickSlice, searchLocal, SOURCE } from './local.js';

const BASE = 'https://www.loc.gov/collections/chronicling-america/';
const UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_newspapers',
    description:
      'Full-text search of digitized historical U.S. newspapers (~1690s–present) from the Library of Congress "Chronicling America" collection. Find primary-source newspaper coverage of any person, event, place, or topic in history — returns the total match count, then for each page the newspaper, publication date, city/state and a link to the digitized page (plus an OCR text excerpt of the matching page for covered states such as Montana). Filter by date range and U.S. state; every response carries data_as_of. Example: search_newspapers({ query: "influenza epidemic", date_from: "1918", date_to: "1919", state: "oklahoma" }).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search terms (matched against the OCR\'d newspaper text).' },
        date_from: { type: 'string', description: 'Earliest year or date (e.g. "1918" or "1918-01-01"). Defaults to the collection start.' },
        date_to: { type: 'string', description: 'Latest year or date (e.g. "1919"). Defaults to present.' },
        state: { type: 'string', description: 'U.S. state to restrict to: name or postal code (e.g. "california", "new york", "MT").' },
        limit: { type: 'number', description: 'Number of results (default 10, max 25).' },
      },
      required: ['query'],
    },
  },
];

interface LocResult {
  title?: string;
  date?: string;
  id?: string;
  url?: string;
  image_url?: string[] | string;
  location_city?: string[] | string;
  location_state?: string[] | string;
  language?: string[] | string;
  description?: string[] | string;
}

/** "1922-03-09" stays a day bound; a bare year is a year bound and yields null here. */
function fullDate(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function first(v: string[] | string | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function year(v: string | undefined): string | null {
  if (!v) return null;
  const m = String(v).match(/\d{4}/);
  return m ? m[0] : null;
}

// "Image 5 of Audubon Republican (Audubon, Iowa), May 11, 1916" → newspaper name
function cleanNewspaper(title: string | undefined): string | null {
  if (!title) return null;
  return title
    .replace(/^Image\s+\d+\s+of\s+/i, '')
    .replace(/,\s+[A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4}\s*$/i, '') // strip trailing date
    .trim() || null;
}

// LoC (www.loc.gov) 403s Cloudflare Worker egress IPs on every UA. The gateway
// injects _proxyUrl/_proxyToken (its EGRESS_PROXY_* secrets) for this pack; when
// present we route the fetch through the non-CF relay, which returns LoC's
// response verbatim. Absent (local dev / non-CF) we fetch direct.
async function locFetch(target: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const proxyUrl = (args._proxyUrl as string | undefined)?.trim();
  const proxyToken = (args._proxyToken as string | undefined)?.trim();
  if (proxyUrl && proxyToken) {
    return fetch(proxyUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target }),
      signal,
    });
  }
  return fetch(target, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal });
}

// supabase/functions/egress-proxy/index.ts synthesizes exactly these {error}
// bodies for a request that never reached loc.gov at all — a dead/missing
// bearer token, a host the relay's allow-list dropped, a malformed target URL.
// Every one of those is OUR configuration, not Library of Congress refusing
// us, and must book as our own outage (fleet #1096's internal-host fix) or a
// dead relay token reads as "LoC is down" forever. `upstream_fetch_failed`
// (502) is deliberately excluded: that is the relay's own fetch to LoC
// failing at the network level, which is a statement about LoC's reachability
// from the relay's egress, not about our side of the hop.
const RELAY_SELF_ERRORS = new Set(['unauthorized', 'bad_request', 'bad_url', 'host_not_allowed', 'method_not_allowed']);

// Fleet #3246: LoC's search WAF is a lottery, not a wall (see the file header).
// Retrying a few times against the SAME endpoint recovers real answers that a
// single-shot call would have reported as `upstream_down`/`upstream_throttled`.
// Bounded well under the gateway's 75s default tools/call budget
// (`workers/gateway/src/request-budget.ts`) even in the worst case: 4 attempts
// x 10s + backoff is ~41s, leaving over 30s of margin.
const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_BASE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown by a single attempt; `retryable` says whether another attempt is worth making. */
class LocAttemptError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

// One attempt against the LoC endpoint: fetch, classify the outcome, and
// either return the parsed body or throw a LocAttemptError carrying whether
// trying again has any chance of doing better. All error-message conventions
// (upstream_down:/upstream_throttled: prefixes, markInternalOrigin,
// dropClassPrefix on embedded fragments) are unchanged from the single-shot
// version this replaces — only the retry/no-retry decision is new.
async function attemptOnce(
  target: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ results?: LocResult[]; pagination?: { of?: number } }> {
  const proxyUrl = (args._proxyUrl as string | undefined)?.trim();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await locFetch(target, args, controller.signal);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new LocAttemptError(`upstream_down: Library of Congress did not respond within ${Math.round(timeoutMs / 1000)}s.`, true);
    }
    // A network-level failure here (DNS, TLS, connection refused) means the
    // fetch never got an HTTP response from ANYONE — when a relay is in play
    // that is our own relay unreachable, not LoC. markInternalOrigin no-ops
    // when proxyUrl is undefined (direct-fetch path, isPipeworxOrigin rejects
    // www.loc.gov), so the direct path keeps its own upstream_down: prefix.
    // `detail` is a fetch()-level failure, never ours, but it is embedded as a
    // FRAGMENT below (never at position 0) — dropClassPrefix() inline, in
    // EACH branch, strips any token it might coincidentally start with and
    // lets the outer message declare the real class, per check:class-prefix.
    const detail = (e as Error)?.message ?? String(e);
    if (proxyUrl) {
      throw new LocAttemptError(markInternalOrigin(`chronicling-america egress relay unreachable: ${dropClassPrefix(detail)}`, proxyUrl), true);
    }
    throw new LocAttemptError(`upstream_down: Library of Congress unreachable: ${dropClassPrefix(detail)}`, true);
  } finally {
    clearTimeout(t);
  }

  if (!res.ok && proxyUrl) {
    // Sniff for the relay's OWN synthesized error envelope before trusting
    // `res.status` as LoC's status — see RELAY_SELF_ERRORS above. This is our
    // own misconfiguration (a dead token, a dropped host), not LoC's WAF
    // lottery, so it is never worth retrying.
    let relayBody: { error?: unknown } = {};
    try { relayBody = (await res.clone().json()) as { error?: unknown }; } catch { /* not JSON => a forwarded LoC response */ }
    if (typeof relayBody.error === 'string' && RELAY_SELF_ERRORS.has(relayBody.error)) {
      throw new LocAttemptError(markInternalOrigin(`chronicling-america egress relay error: ${relayBody.error}`, proxyUrl, 500), false);
    }
  }
  if (!res.ok) {
    // 403/429 from LoC itself is access-denial/rate-limit shaped — classify it
    // explicitly rather than relying on `\b403\b` happening to appear in the
    // message text (classifyToolError's generic wording rule). 5xx and the
    // timeout above are the only other case LoC itself produces, and all three
    // are exactly the WAF-lottery shape worth retrying.
    const retryable = res.status >= 500 || res.status === 403 || res.status === 429;
    const prefix = res.status >= 500 ? 'upstream_down: ' : res.status === 403 || res.status === 429 ? 'upstream_throttled: ' : '';
    throw new LocAttemptError(`${prefix}Library of Congress error: HTTP ${res.status}`, retryable);
  }

  return (await res.json()) as { results?: LocResult[]; pagination?: { of?: number } };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'search_newspapers') throw new Error(`Unknown tool: ${name}`);

  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('Required argument "query" is missing. Pass search terms, e.g. search_newspapers({ query: "gold rush" }).');
  }
  const limit = Math.min(25, Math.max(1, Math.floor(Number(args.limit)) || 10));

  const p = new URLSearchParams({ q: query, fo: 'json', c: String(limit), at: 'results,pagination' });

  const fromY = year(args.date_from as string | undefined);
  const toY = year(args.date_to as string | undefined);
  if (fromY || toY) p.set('dates', `${fromY ?? '1690'}/${toY ?? '2030'}`);

  const state = normalizeState(args.state as string | undefined);
  if (state) p.set('fa', `location_state:${state}`);

  // Fleet #3246: a state inside Pipeworx search coverage is answered there
  // (local.ts); LoC's own keyword search (below) answers everything else. An
  // infrastructure failure falls through to the LoC search and says so — it
  // is never reported as "no matching pages".
  let localError: string | null = null;
  const picked = await pickSlice(args, state, fromY ? Number(fromY) : null, toY ? Number(toY) : null);
  if (picked) {
    try {
      const local = await searchLocal(args, picked, {
        query, limit,
        fromY: fromY ? Number(fromY) : null, toY: toY ? Number(toY) : null,
        fromDate: fullDate(args.date_from), toDate: fullDate(args.date_to),
      });
      const filters_tried = { query, date_from: fromY ?? null, date_to: toY ?? null, state: state ?? null };
      return {
        query,
        filters_tried,
        total_matches: local.total_matches,
        returned: local.returned,
        served_from: local.served_from,
        match_mode: local.match_mode,
        data_as_of: local.data_as_of,
        source: SOURCE,
        coverage: local.coverage,
        note: local.returned === 0
          ? `No ${state} newspaper pages match ${JSON.stringify(filters_tried)}. Coverage is ${JSON.stringify(local.coverage.years)}; try other words (OCR text is noisy, so a common synonym often matches) or widen the date range.`
          : `Pages from digitized ${state} newspapers held by the Library of Congress (Chronicling America), ranked by relevance. page_url opens the page on loc.gov; excerpt is the page's OCR text around the first matching word.`,
        results: local.results,
      };
    } catch (e) {
      localError = e instanceof LocalStoreError ? e.message : `search error: ${dropClassPrefix(String((e as Error)?.message ?? e)).slice(0, 120)}`;
    }
  }

  const target = `${BASE}?${p}`;
  let data: { results?: LocResult[]; pagination?: { of?: number } } | undefined;
  let lastErr: Error = new Error('search_newspapers: no attempt ran');
  let attemptsTried = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsTried = attempt;
    try {
      data = await attemptOnce(target, args, ATTEMPT_TIMEOUT_MS);
      lastErr = undefined as unknown as Error;
      break;
    } catch (e) {
      lastErr = e as Error;
      const retryable = e instanceof LocAttemptError ? e.retryable : false;
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_BACKOFF_BASE_MS * attempt + Math.floor(Math.random() * 200));
    }
  }
  if (!data) {
    // Preserve the final attempt's class prefix (position 0) exactly; the
    // attempt count actually made is appended as a trailing fragment, never
    // prepended, so check:class-prefix still sees one classifier token at the
    // start — and a non-retryable failure truthfully says "tried 1 time"
    // rather than claiming retries that never happened.
    throw new Error(`${lastErr.message}${attemptsTried > 1 ? ` (tried ${attemptsTried} times)` : ''}`);
  }

  const results = (data.results ?? []).map((r) => ({
    newspaper: cleanNewspaper(r.title),
    date: r.date ?? null,
    city: first(r.location_city),
    state: first(r.location_state),
    language: first(r.language),
    page_url: r.url ?? r.id ?? null,
    page_image: first(r.image_url),
  }));

  return {
    query,
    filters_tried: { query, date_from: fromY ?? null, date_to: toY ?? null, state: state ?? null },
    total_matches: data.pagination?.of ?? null,
    returned: results.length,
    served_from: 'loc_search',
    data_as_of: new Date().toISOString().slice(0, 10),
    source: SOURCE,
    ...(localError ? { search_fallback: `Pipeworx search for this state was unavailable (${localError}); answered from the Library of Congress search instead.` } : {}),
    note: results.length === 0
      ? 'No matching newspaper pages for these filters (query/date range/state). Try a broader date range or drop the state filter.'
      : 'Historical U.S. newspaper pages from the Library of Congress (Chronicling America). page_url opens the digitized page on loc.gov; page_image is the scanned-page image.',
    results,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
