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

/** Day number as the rowid layout counts it; the shard filters on this (search-shard.ts). */
export function dayNumber(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - DAY0) / 86_400_000);
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

// ── shapes ──
interface R2Obj { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }
interface R2Like {
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2Obj | null>;
  list?(opts: { prefix: string; limit?: number }): Promise<{ objects: { key: string }[] }>;
}
interface ShardStub { fetch: (url: string, init?: RequestInit) => Promise<Response> }
interface ShardNs { idFromName(name: string): unknown; get(id: unknown): ShardStub }

/** Pilot (fleet #3246) coverage entry: one awardee. Still read when no `coverage` block exists. */
export interface SliceState {
  awardee: string; state: string | null; fips: string | null; shards: string[];
  year_min: number | null; year_max: number | null; pages_indexed: number; pages_listed: number;
  batches_applied: number; batches_listed: number; complete: boolean; data_as_of: string | null;
}
interface ShardInfo { states: Record<string, number>; year_min: number | null; year_max: number | null; pages?: number; documents?: number }
interface CoverageEntry { complete: boolean; batches_total: number; batches_applied: number; shards?: string[]; year_min: number | null; year_max: number | null }
interface StateDoc {
  data_as_of: string | null; listing_checked_at?: string; slices?: Record<string, SliceState>;
  coverage?: { national: CoverageEntry & { pages_listed?: number }; states: Record<string, CoverageEntry>; shards: Record<string, ShardInfo> };
}
interface TitleRow { idx: number; name: string | null; title_full?: string | null; city: string | null; state: string | null; states?: string[]; parts?: Record<string, string[]> }
interface TitlesDoc { titles: Record<string, TitleRow> }
interface PageIdx { idx: Record<string, [number, number]> }

/** What one call will search: resolved from coverage, never hard-coded. */
export interface Picked {
  scope: string;                 // "montana" or "national"
  fips: string | null;           // state filter token, null for national
  shards: { name: string; year_min: number | null; year_max: number | null }[];
  year_min: number; year_max: number;
  pages: number | null;
  batches: string;
  data_as_of: string | null;
}

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

function decadeOf(shard: string): number | null {
  const m = /-(\d{4})$/.exec(shard);
  return m ? Number(m[1]) : null;
}

const overlaps = (s: { year_min: number | null; year_max: number | null }, lo: number, hi: number) =>
  s.year_min == null || s.year_max == null || (s.year_max >= lo && s.year_min <= hi);

/**
 * What (if anything) Pipeworx search answers for this call. Null means "use
 * the LoC search": a state whose batches are not all in yet, a national
 * question before every batch is in, a date range outside coverage, or a
 * runtime without the gateway's bindings. Coverage is read from the gateway at
 * call time, so states start answering here as they complete.
 */
export async function pickCoverage(args: Record<string, unknown>, state: string | undefined, fromY: number | null, toY: number | null): Promise<Picked | null> {
  const b = bindings(args);
  if (!b) return null;
  let doc: StateDoc | null;
  try { doc = await readJson<StateDoc>(b.r2, `${PREFIX}/_state.json`); } catch { return null; }
  if (!doc) return null;
  const lo = fromY ?? -Infinity, hi = toY ?? Infinity;

  if (doc.coverage) {
    const cov = doc.coverage;
    const entry = state ? cov.states?.[state] : cov.national;
    if (!entry?.complete || entry.year_min == null || entry.year_max == null) return null;
    if (hi < entry.year_min || lo > entry.year_max) return null;
    const names = state ? (entry.shards ?? []) : Object.keys(cov.shards ?? {});
    const shards = names
      .map((name) => ({ name, year_min: cov.shards[name]?.year_min ?? null, year_max: cov.shards[name]?.year_max ?? null, pages: cov.shards[name]?.documents ?? cov.shards[name]?.pages ?? 0 }))
      .filter((x) => overlaps(x, lo, hi));
    if (!shards.length) return null;
    return {
      scope: state ?? 'national',
      fips: state ? STATE_FIPS[state] ?? null : null,
      shards,
      year_min: entry.year_min, year_max: entry.year_max,
      pages: state ? shards.reduce((n, x) => n + (cov.shards[x.name]?.states?.[state] ?? 0), 0) || null : shards.reduce((n, x) => n + (x.pages ?? 0), 0) || null,
      batches: `${entry.batches_applied} of ${entry.batches_total}`,
      data_as_of: doc.data_as_of ?? null,
    };
  }

  // Pilot format (before fleet #3334's first aggregate): one state, decade shards.
  if (!state || !doc.slices) return null;
  const slice = Object.values(doc.slices).find((x) => x.state === state && x.pages_indexed > 0 && x.shards?.length);
  if (!slice || slice.year_min == null || slice.year_max == null) return null;
  if (hi < slice.year_min || lo > slice.year_max) return null;
  const shards = slice.shards.map((name) => { const d = decadeOf(name); return { name, year_min: d, year_max: d == null ? null : d + 9 }; }).filter((x) => overlaps(x, lo, hi));
  return { scope: state, fips: slice.fips, shards, year_min: slice.year_min, year_max: slice.year_max, pages: slice.pages_indexed, batches: `${slice.batches_applied} of ${slice.batches_listed}`, data_as_of: slice.data_as_of ?? doc.data_as_of ?? null };
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
  const full = t?.title_full?.replace(/\s+[\d?]{4}-(?:[\d?]{1,4}|current)?\s*$/i, '').trim();
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

/** National questions fan out to every shard; these bound what that costs. */
const FANOUT_CONCURRENCY = 48;
const FANOUT_DEADLINE_MS = 10_000;
/** Wall budget for the whole call (local search plus any LoC fallback). The caller's own client gives up
 *  around 45s; a fallback leg is only started if it can finish inside this, never beyond it. */
export const CALL_BUDGET_MS = 26_000;
/** Exact totals need a full match count per shard; past this many shards it is skipped. */
const COUNT_MAX_SHARDS = 12;

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms); });
  try { return await Promise.race([p, timer]); } finally { if (t !== undefined) clearTimeout(t); }
}

async function pageText(r2: R2Like, lccn: string, t: TitleRow, date: string, edition: number, seq: number): Promise<string | null> {
  const year = date.slice(0, 4);
  const key = `${date.slice(5)}.${edition}.${seq}`;
  const bases: string[] = [];
  for (const batch of t.parts?.[year] ?? []) bases.push(`${PREFIX}/text/${batch}/${lccn}/${year}`);
  if (!bases.length && typeof r2.list === 'function') {
    const listed = await r2.list({ prefix: `${PREFIX}/t/${lccn}/${year}/`, limit: 50 });
    for (const o of listed.objects) if (o.key.endsWith('.idx.json')) bases.push(o.key.slice(0, -'.idx.json'.length));
  }
  for (const base of bases) {
    const idx = await readJson<PageIdx>(r2, `${base}.idx.json`).catch(() => null);
    const loc = idx?.idx?.[key];
    if (!loc) continue;
    const obj = await r2.get(`${base}.bin`, { range: { offset: loc[0], length: loc[1] } });
    if (obj) return await gunzip(await obj.arrayBuffer());
  }
  return null;
}

/** Throws LocalStoreError on any infrastructure failure (the caller falls back to the LoC search). */
export async function searchLocal(
  args: Record<string, unknown>,
  picked: Picked,
  q: { query: string; limit: number; fromY: number | null; toY: number | null; fromDate: string | null; toDate: string | null },
): Promise<LocalResult & { shards_searched: number; shards_answered: number; complete: boolean; missing_partitions: string[] }> {
  const b = bindings(args);
  if (!b) throw new LocalStoreError('search bindings absent');
  const terms = queryTerms(q.query);
  if (!terms.length) throw new LocalStoreError('query has no searchable words');
  const lo = Math.max(q.fromY ?? picked.year_min, picked.year_min);
  const hi = Math.min(q.toY ?? picked.year_max, picked.year_max);
  const wholeSpan = lo <= picked.year_min && hi >= picked.year_max;
  const years = wholeSpan ? null : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const shards = picked.shards;
  const count = shards.length <= COUNT_MAX_SHARDS;
  const want = Math.min(100, Math.max(q.limit * 3, 30));
  const started = Date.now();
  // Day-precision bounds go INTO the shard query (the year/month tokens only narrow to a year). Filtering
  // after retrieval made total_matches count the whole year while the rows were cut to the requested days:
  // "237 matches, 0 returned", and real in-range matches pushed out of the top 30 by out-of-range ones.
  const dayMin = q.fromDate ? dayNumber(q.fromDate) : null;
  const dayMax = q.toDate ? dayNumber(q.toDate) : null;
  const dayFiltered = dayMin != null || dayMax != null;

  const ask = async (mode: 'all' | 'any') => {
    const match = buildMatch(terms, mode, picked.fips, years);
    type ShardOut = { total?: number; day_filtered?: boolean; results?: { opinion_id: number; score: number }[] };
    const outs: (ShardOut | null)[] = new Array(shards.length).fill(null);
    let next = 0, failures = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= shards.length) return;
        const left = FANOUT_DEADLINE_MS - (Date.now() - started);
        if (left <= 0) return;
        const r = await withDeadline((async () => {
          const res = await b.ns.get(b.ns.idFromName(shards[i].name)).fetch('https://shard/query', {
            method: 'POST',
            body: JSON.stringify({ q: match, limit: want, count, ...(dayFiltered ? { day_min: dayMin, day_max: dayMax } : {}) }),
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
          });
          if (!res.ok) throw new LocalStoreError(`search shard ${shards[i].name} answered HTTP ${res.status}`);
          return (await res.json()) as ShardOut;
        })().catch((e) => { failures++; if (shards.length === 1) throw e; return null; }), left);
        if (r !== 'timeout') outs[i] = r;
      }
    };
    await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, shards.length) }, worker));
    const answered = outs.filter((o): o is NonNullable<typeof o> => o != null);
    if (!answered.length) throw new LocalStoreError(failures ? `no search shard answered (${failures} failed)` : 'no search shard answered in time');
    return {
      answered: answered.length,
      missing: shards.filter((_, i) => outs[i] == null).map((x) => x.name),
      // A shard that predates the day filter ignores it and counts the whole year; its total is not ours to report.
      dayFilterHeld: !dayFiltered || answered.every((o) => o.day_filtered === true),
      // null, not 0, when any shard did not report a count (not asked, not
      // answered): "not counted" must never read as "nothing matched".
      total: answered.length === shards.length && (!dayFiltered || answered.every((o) => o.day_filtered === true)) && answered.every((o) => typeof o.total === 'number') ? answered.reduce((n, o) => n + (o.total as number), 0) : null,
      hits: answered.flatMap((o) => o.results ?? []).sort((x, y) => x.score - y.score),
    };
  };
  let mode: 'all' | 'any' = 'all';
  let got = await ask('all');
  if (!got.hits.length && terms.length > 1 && Date.now() - started < FANOUT_DEADLINE_MS / 2) { mode = 'any'; got = await ask('any'); }

  const titlesDoc = await readJson<TitlesDoc>(b.r2, `${PREFIX}/titles.json`);
  if (!titlesDoc) throw new LocalStoreError('title table unavailable');
  const byIdx = new Map<number, [string, TitleRow]>();
  for (const [lccn, t] of Object.entries(titlesDoc.titles)) byIdx.set(t.idx, [lccn, t]);

  // Day-precision bounds are applied after retrieval (the index filters by year).
  const inDates = (d: string) => (!q.fromDate || d >= q.fromDate) && (!q.toDate || d <= q.toDate);
  const seen = new Set<number>();
  const picks = got.hits.filter((h) => !seen.has(h.opinion_id) && seen.add(h.opinion_id))
    .map((h) => ({ h, p: decodeRowid(h.opinion_id) })).filter((x) => inDates(x.p.date)).slice(0, q.limit);

  const results = await Promise.all(picks.map(async ({ h, p }) => {
    const row = byIdx.get(p.titleIdx);
    const lccn = row?.[0] ?? null;
    const t = row?.[1];
    const text = lccn && t ? await pageText(b.r2, lccn, t, p.date, p.edition, p.seq).catch(() => null) : null;
    return {
      newspaper: displayTitle(t),
      date: p.date,
      city: t?.city ?? null,
      // When the caller asked for a state, name THAT state if the paper publishes there: a title that moved or merged
      // ("(Atlanta, Ga.)" that was also published in Richmond) is genuinely in both, and showing only the first
      // read as a filter that had let another state's papers through. `states` lists every state it is tagged with.
      state: (picked.scope !== 'national' && t?.states?.includes(picked.scope)) ? picked.scope : (t?.states?.[0] ?? t?.state ?? (picked.scope === 'national' ? null : picked.scope)),
      states: t?.states?.length ? t.states : null,
      page: p.seq,
      edition: p.edition,
      lccn,
      excerpt: text ? excerpt(text, terms) : null,
      page_url: lccn ? pageUrl(lccn, p.date, p.edition, p.seq) : null,
      relevance: Math.round(-h.score * 100) / 100,
    };
  }));

  // A count and a payload from two different paths that disagree is a defect, not an answer. Fall back to the
  // LoC search (and say so) rather than serve "N matches, 0 returned".
  if (got.total != null && got.total > 0 && results.length === 0) {
    throw new LocalStoreError(`search count (${got.total}) and rows (0) disagree`);
  }
  if (dayFiltered && !got.dayFilterHeld && results.length === 0 && got.hits.length > 0) {
    throw new LocalStoreError('search partition did not apply the day range');
  }

  const complete = got.answered === shards.length;
  const scopeName = picked.scope === 'national' ? 'every U.S. state and territory' : picked.scope[0].toUpperCase() + picked.scope.slice(1);
  return {
    served_from: 'pipeworx_search',
    total_matches: got.total,
    returned: results.length,
    match_mode: mode === 'all' ? 'all_terms' : 'any_term',
    shards_searched: shards.length,
    shards_answered: got.answered,
    complete,
    missing_partitions: got.missing,
    coverage: {
      what: `Every digitized page the Library of Congress's Chronicling America holds for ${scopeName}`,
      years: [picked.year_min, picked.year_max],
      pages_searched: picked.pages,
      batches: picked.batches,
      ...(!complete ? { partial: `INCOMPLETE: ${got.answered} of ${shards.length} search partitions answered within the time limit; these results come only from those, so matches in the other ${shards.length - got.answered} are missing. Repeat the same call (a slow partition is usually warm by then) or narrow the dates.` } : {}),
      ...(got.total === null && count === false ? { total_matches_note: 'not counted for questions spanning many partitions' } : {}),
    },
    data_as_of: picked.data_as_of,
    results,
  };
}
