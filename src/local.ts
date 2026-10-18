/**
 * Pipeworx search path for search_newspapers (fleet #3246).
 *
 * Used when the caller's state filter names a state listed in the coverage
 * document the gateway provides (read at call time, never hard-coded here)
 * and the date range overlaps it. The `_r2` and `_searchShards` arguments are
 * injected by the Pipeworx gateway; a runtime without them (a standalone
 * install) always uses the Library of Congress search in index.ts.
 *
 * The rowid layout and the state/year filter tokens are pinned by the fixed
 * vectors in local.test.ts.
 */

export const PREFIX = 'chronam';
export const SOURCE = 'Library of Congress, Chronicling America (National Digital Newspaper Program) page OCR';
const UA = 'pipeworx-mcp-chronicling-america/1.0 (+https://pipeworx.io)';

// ── rowid layout ──
const DAY0 = Date.UTC(1690, 0, 1);

export function encodeRowid(p: { titleIdx: number; date: string; edition: number; seq: number }): number {
  const day = Math.round((Date.parse(`${p.date}T00:00:00Z`) - DAY0) / 86_400_000);
  return ((p.titleIdx * 131072 + day) * 8 + (p.edition - 1)) * 1024 + p.seq;
}

export function decodeRowid(rowid: number): { titleIdx: number; date: string; edition: number; seq: number } {
  let r = rowid;
  const seq = r % 1024; r = Math.floor(r / 1024);
  const edition = (r % 8) + 1; r = Math.floor(r / 8);
  const day = r % 131072;
  const titleIdx = Math.floor(r / 131072);
  return { titleIdx, date: new Date(DAY0 + day * 86_400_000).toISOString().slice(0, 10), edition, seq };
}

export const STATE_FIPS: Record<string, string> = {
  alabama: '01', alaska: '02', arizona: '04', arkansas: '05', california: '06', colorado: '08',
  connecticut: '09', delaware: '10', 'district of columbia': '11', florida: '12', georgia: '13',
  hawaii: '15', idaho: '16', illinois: '17', indiana: '18', iowa: '19', kansas: '20', kentucky: '21',
  louisiana: '22', maine: '23', maryland: '24', massachusetts: '25', michigan: '26', minnesota: '27',
  mississippi: '28', missouri: '29', montana: '30', nebraska: '31', nevada: '32', 'new hampshire': '33',
  'new jersey': '34', 'new mexico': '35', 'new york': '36', 'north carolina': '37', 'north dakota': '38',
  ohio: '39', oklahoma: '40', oregon: '41', pennsylvania: '42', 'rhode island': '44',
  'south carolina': '45', 'south dakota': '46', tennessee: '47', texas: '48', utah: '49', vermont: '50',
  virginia: '51', washington: '53', 'west virginia': '54', wisconsin: '55', wyoming: '56',
  'puerto rico': '72', 'virgin islands': '78',
};

const POSTAL: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
  de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
  in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
  nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
  vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  pr: 'puerto rico', vi: 'virgin islands', mont: 'montana',
};

/** "Montana", "MT", "Mont." -> "montana"; anything unrecognised is returned lowercased as-is. */
export function normalizeState(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (!s) return undefined;
  if (STATE_FIPS[s]) return s;
  return POSTAL[s] ?? s;
}

// ── store shapes ──
interface R2Obj { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }
interface R2Like { get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2Obj | null> }
interface ShardStub { fetch: (url: string, init?: RequestInit) => Promise<Response> }
interface ShardNs { idFromName(name: string): unknown; get(id: unknown): ShardStub }

export interface SliceState {
  awardee: string; state: string | null; fips: string | null; shards: string[];
  year_min: number | null; year_max: number | null; pages_indexed: number; pages_listed: number;
  batches_applied: number; batches_listed: number; complete: boolean; data_as_of: string | null;
}
interface StateDoc { data_as_of: string | null; listing_checked_at?: string; slices: Record<string, SliceState> }
interface TitleRow { idx: number; name: string | null; title_full?: string | null; city: string | null; state: string | null; parts: Record<string, string[]> }
interface TitlesDoc { titles: Record<string, TitleRow> }
interface PageIdx { idx: Record<string, [number, number]> }

/** An infrastructure failure: the caller falls back to the LoC search rather than reporting "no matches". */
export class LocalStoreError extends Error {}

const TTL_MS = 10 * 60 * 1000;
const caches = new WeakMap<object, Map<string, { at: number; v: unknown }>>();
async function readJson<T>(r2: R2Like, key: string): Promise<T | null> {
  let c = caches.get(r2);
  if (!c) { c = new Map(); caches.set(r2, c); }
  const hit = c.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const obj = await r2.get(key);
  if (!obj) return null;
  const v = JSON.parse(await obj.text()) as T;
  if (c.size > 256) c.clear();
  c.set(key, { at: Date.now(), v });
  return v;
}

function bindings(args: Record<string, unknown>): { r2: R2Like; ns: ShardNs } | null {
  const r2 = args._r2 as R2Like | undefined;
  const ns = args._searchShards as ShardNs | undefined;
  if (!r2 || typeof r2.get !== 'function' || !ns || typeof ns.idFromName !== 'function') return null;
  return { r2, ns };
}

/**
 * Which coverage entry (if any) answers this call. Null means "use the LoC
 * search": no state filter, a state outside coverage, a date range entirely
 * outside its years, or a runtime without the gateway's bindings.
 */
export async function pickSlice(args: Record<string, unknown>, state: string | undefined, fromY: number | null, toY: number | null):
  Promise<{ slice: SliceState; doc: StateDoc } | null> {
  if (!state) return null;
  const b = bindings(args);
  if (!b) return null;
  let doc: StateDoc | null;
  try { doc = await readJson<StateDoc>(b.r2, `${PREFIX}/_state.json`); } catch { return null; }
  if (!doc?.slices) return null;
  const slice = Object.values(doc.slices).find((s) => s.state === state && s.pages_indexed > 0 && s.shards?.length);
  if (!slice || slice.year_min == null || slice.year_max == null) return null;
  const lo = fromY ?? -Infinity, hi = toY ?? Infinity;
  if (hi < slice.year_min || lo > slice.year_max) return null;
  return { slice, doc };
}

/** Split a caller's query into FTS5-safe quoted terms and phrases. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let rest = query;
  for (const m of query.matchAll(phraseRe)) {
    const words = m[1].toLowerCase().match(/[\p{L}\p{N}]+/gu);
    if (words?.length) out.push(`"${words.join(' ')}"`);
    rest = rest.replace(m[0], ' ');
  }
  for (const w of rest.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (['and', 'or', 'not', 'near'].includes(w) && out.length) continue;
    out.push(`"${w}"`);
  }
  return [...new Set(out)].slice(0, 12);
}

export function buildMatch(terms: string[], mode: 'all' | 'any', fips: string | null, years: number[] | null): string {
  let q = `(${terms.join(mode === 'all' ? ' AND ' : ' OR ')})`;
  if (fips) q += ` AND zzs${fips}`;
  if (years && years.length) q += ` AND (${years.map((y) => `zzy${y}`).join(' OR ')})`;
  return q;
}

function decadeOf(shard: string): number | null {
  const m = /-(\d{4})$/.exec(shard);
  return m ? Number(m[1]) : null;
}

async function gunzip(buf: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

function excerpt(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const w = t.replace(/"/g, '');
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, 280) + (flat.length > 280 ? '…' : '');
  const start = Math.max(0, at - 140);
  return (start > 0 ? '…' : '') + flat.slice(start, start + 300) + (start + 300 < flat.length ? '…' : '');
}

/** "The Helena independent (Helena, Mont.) 1875-1943" -> "The Helena independent (Helena, Mont.)" —
 *  the same shape the LoC search returns, so a caller sees one naming either way. */
export function displayTitle(t: { name: string | null; title_full?: string | null } | undefined): string | null {
  const full = t?.title_full?.replace(/\s+\d{4}-(?:[\d?]{1,4}|current)?\s*$/i, '').trim();
  return full || t?.name || null;
}

export function pageUrl(lccn: string, date: string, edition: number, seq: number): string {
  return `https://www.loc.gov/resource/${lccn}/${date}/ed-${edition}/?sp=${seq}&st=text`;
}

export interface LocalResult {
  served_from: 'pipeworx_search';
  total_matches: number | null;
  returned: number;
  match_mode: 'all_terms' | 'any_term';
  coverage: Record<string, unknown>;
  data_as_of: string | null;
  results: Record<string, unknown>[];
}

/** Throws LocalStoreError on any infrastructure failure (the caller falls back to the LoC search). */
export async function searchLocal(
  args: Record<string, unknown>,
  picked: { slice: SliceState; doc: StateDoc },
  q: { query: string; limit: number; fromY: number | null; toY: number | null; fromDate: string | null; toDate: string | null },
): Promise<LocalResult> {
  const b = bindings(args);
  if (!b) throw new LocalStoreError('search bindings absent');
  const { slice } = picked;
  const terms = queryTerms(q.query);
  if (!terms.length) throw new LocalStoreError('query has no searchable words');
  const lo = Math.max(q.fromY ?? slice.year_min!, slice.year_min!);
  const hi = Math.min(q.toY ?? slice.year_max!, slice.year_max!);
  const wholeSpan = lo <= slice.year_min! && hi >= slice.year_max!;
  const years = wholeSpan ? null : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const shards = slice.shards.filter((s) => {
    const d = decadeOf(s);
    return d == null || (d + 9 >= lo && d <= hi);
  });
  const want = Math.min(100, Math.max(q.limit * 3, 30));

  const ask = async (mode: 'all' | 'any') => {
    const match = buildMatch(terms, mode, slice.fips, years);
    const outs = await Promise.all(shards.map(async (name) => {
      const res = await b.ns.get(b.ns.idFromName(name)).fetch('https://shard/query', {
        method: 'POST',
        body: JSON.stringify({ q: match, limit: want, count: true }),
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      });
      if (!res.ok) throw new LocalStoreError(`search shard ${name} answered HTTP ${res.status}`);
      return (await res.json()) as { total?: number; results?: { opinion_id: number; score: number }[] };
    }));
    return {
      // null, not 0, when a shard did not report a count: "not counted" must
      // never read as "nothing matched" beside a list of matches.
      total: outs.every((o) => typeof o.total === 'number') ? outs.reduce((n, o) => n + (o.total as number), 0) : null,
      hits: outs.flatMap((o) => o.results ?? []).sort((x, y) => x.score - y.score),
    };
  };
  let mode: 'all' | 'any' = 'all';
  let got = await ask('all');
  if (!got.hits.length && terms.length > 1) { mode = 'any'; got = await ask('any'); }

  const titlesDoc = await readJson<TitlesDoc>(b.r2, `${PREFIX}/titles.json`);
  if (!titlesDoc) throw new LocalStoreError('title table unavailable');
  const byIdx = new Map<number, [string, TitleRow]>();
  for (const [lccn, t] of Object.entries(titlesDoc.titles)) byIdx.set(t.idx, [lccn, t]);

  // Day-precision bounds are applied after retrieval (the index filters by year).
  const inDates = (d: string) => (!q.fromDate || d >= q.fromDate) && (!q.toDate || d <= q.toDate);
  const picks = got.hits.map((h) => ({ h, p: decodeRowid(h.opinion_id) })).filter((x) => inDates(x.p.date)).slice(0, q.limit);

  const results = await Promise.all(picks.map(async ({ h, p }) => {
    const row = byIdx.get(p.titleIdx);
    const lccn = row?.[0] ?? null;
    const t = row?.[1];
    let text: string | null = null;
    if (lccn && t) {
      const year = p.date.slice(0, 4);
      const key = `${p.date.slice(5)}.${p.edition}.${p.seq}`;
      for (const batch of t.parts?.[year] ?? []) {
        const base = `${PREFIX}/text/${batch}/${lccn}/${year}`;
        const idx = await readJson<PageIdx>(b.r2, `${base}.idx.json`).catch(() => null);
        const loc = idx?.idx?.[key];
        if (!loc) continue;
        const obj = await b.r2.get(`${base}.bin`, { range: { offset: loc[0], length: loc[1] } });
        if (obj) { text = await gunzip(await obj.arrayBuffer()); break; }
      }
    }
    return {
      newspaper: displayTitle(t),
      date: p.date,
      city: t?.city ?? null,
      state: t?.state ?? slice.state,
      page: p.seq,
      edition: p.edition,
      lccn,
      excerpt: text ? excerpt(text, terms) : null,
      page_url: lccn ? pageUrl(lccn, p.date, p.edition, p.seq) : null,
      relevance: Math.round(-h.score * 100) / 100,
    };
  }));

  return {
    served_from: 'pipeworx_search',
    total_matches: got.total,
    returned: results.length,
    match_mode: mode === 'all' ? 'all_terms' : 'any_term',
    coverage: {
      what: `Every page in the Library of Congress's Chronicling America batches from the ${slice.state ? slice.state[0].toUpperCase() + slice.state.slice(1) : slice.awardee} NDNP awardee (${slice.awardee})`,
      years: [slice.year_min, slice.year_max],
      pages_searched: slice.pages_indexed,
      batches: `${slice.batches_applied} of ${slice.batches_listed}`,
    },
    data_as_of: slice.data_as_of ?? picked.doc.data_as_of ?? null,
    results,
  };
}
