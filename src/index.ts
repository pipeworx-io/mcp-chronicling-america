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
 * Chronicling America MCP — full-text search of ~150 years of digitized U.S.
 * newspapers (1690s–present) from the Library of Congress.
 *
 * Source: the LoC JSON API (loc.gov/collections/chronicling-america, keyless).
 * The classic chroniclingamerica.loc.gov/search API was retired (404/redirect);
 * this uses the current loc.gov endpoint with `fo=json`.
 *
 * Complements the `trove` pack (Australian historic newspapers) with the U.S.
 * corpus. Tool: search_newspapers.
 */


const BASE = 'https://www.loc.gov/collections/chronicling-america/';
const UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_newspapers',
    description:
      'Full-text search of digitized historical U.S. newspapers (~1690s–present) from the Library of Congress "Chronicling America" collection. Find primary-source newspaper coverage of any person, event, place, or topic in history — returns the newspaper, publication date, city/state, a link to the digitized page, and the page-scan image URL. Filter by date range and U.S. state. Example: search_newspapers({ query: "influenza epidemic", date_from: "1918", date_to: "1919", state: "oklahoma" }).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Full-text search terms (matched against the OCR\'d newspaper text).' },
        date_from: { type: 'string', description: 'Earliest year or date (e.g. "1918" or "1918-01-01"). Defaults to the collection start.' },
        date_to: { type: 'string', description: 'Latest year or date (e.g. "1919"). Defaults to present.' },
        state: { type: 'string', description: 'U.S. state name to restrict to (lowercase, e.g. "california", "new york").' },
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

  const state = (args.state as string | undefined)?.trim().toLowerCase();
  if (state) p.set('fa', `location_state:${state}`);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await locFetch(`${BASE}?${p}`, args, controller.signal);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new Error('upstream_down: Library of Congress did not respond within 15s.');
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const prefix = res.status >= 500 ? 'upstream_down: ' : '';
    throw new Error(`${prefix}Library of Congress error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { results?: LocResult[]; pagination?: { of?: number } };
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
    total_matches: data.pagination?.of ?? null,
    returned: results.length,
    note: 'Historical U.S. newspaper pages from the Library of Congress (Chronicling America). page_url opens the digitized page on loc.gov; page_image is the scanned-page image.',
    results,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
