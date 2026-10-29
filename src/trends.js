// Google Trends web data -> output rows. Pure functions (no network), unit-tested on real responses.

export const TRENDS = (process.env.TRENDS_BASE ?? 'https://trends.google.com').replace(/\/$/, '');

/** Google prefixes JSON with ")]}'" (anti-XSSI). */
export function parseXssi(text) {
    const s = String(text ?? '');
    const i = s.indexOf('{');
    if (i < 0) throw new Error('not a Google Trends JSON answer');
    return JSON.parse(s.slice(i));
}

// ---------- inputs ----------
const TIME_ALIASES = {
    '1h': 'now 1-H', '4h': 'now 4-H', '1d': 'now 1-d', '24h': 'now 1-d', '7d': 'now 7-d', '1w': 'now 7-d',
    '30d': 'today 1-m', '1m': 'today 1-m', '90d': 'today 3-m', '3m': 'today 3-m', '12m': 'today 12-m', '1y': 'today 12-m', '5y': 'today 5-y', all: 'all', alltime: 'all',
};
/** Accepts Google's own strings (today 3-m, now 7-d, all, 2024-01-01 2024-12-31) and short aliases (90d, 12m, 5y). */
export function normalizeTimeframe(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return 'today 12-m';
    const low = s.toLowerCase().replace(/\s+/g, '');
    if (TIME_ALIASES[low]) return TIME_ALIASES[low];
    let m = s.match(/^(now)\s+(1-H|4-H|1-d|7-d)$/i);
    if (m) return `now ${m[2].replace(/h$/i, 'H').replace(/D$/, 'd')}`;
    m = s.match(/^today\s+(\d+)-(m|y)$/i);
    if (m) return `today ${m[1]}-${m[2].toLowerCase()}`;
    if (/^all$/i.test(s)) return 'all';
    m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/);
    if (m) {
        if (m[1] < '2004-01-01') throw new Error(`Google Trends data starts on 2004-01-01 ("${s}").`);
        if (m[1] >= m[2]) throw new Error(`Custom timeframe "${s}": the start date must be before the end date.`);
        return `${m[1]} ${m[2]}`;
    }
    throw new Error(`Unknown timeframe "${s}". Use: now 1-H, now 4-H, now 1-d, now 7-d, today 1-m, today 3-m, today 12-m, today 5-y, all, or "2024-01-01 2024-12-31".`);
}

export const CATEGORIES = {
    all: 0, 'arts & entertainment': 3, 'autos & vehicles': 47, 'beauty & fitness': 44, 'books & literature': 22, 'business & industrial': 12,
    'computers & electronics': 5, finance: 7, 'food & drink': 71, games: 8, health: 45, 'hobbies & leisure': 65, 'home & garden': 11,
    'internet & telecom': 13, 'jobs & education': 958, 'law & government': 19, news: 16, 'online communities': 299, 'people & society': 14,
    'pets & animals': 66, 'real estate': 29, reference: 533, science: 174, shopping: 18, sports: 20, travel: 67,
};
const CATEGORY_ALIASES = { food: 71, tech: 5, technology: 5, computers: 5, electronics: 5, cars: 47, autos: 47, beauty: 44, fitness: 44, books: 22, business: 12, entertainment: 3, arts: 3, jobs: 958, education: 958, law: 19, government: 19, pets: 66, animals: 66, home: 11, garden: 11, internet: 13, telecom: 13, hobbies: 65, people: 14, society: 14 };
export function normalizeCategory(raw) {
    if (raw === undefined || raw === null || raw === '') return 0;
    if (Number.isFinite(Number(raw))) return Math.max(0, Math.floor(Number(raw)));
    const k = String(raw).trim().toLowerCase().replace(/\s+and\s+/g, ' & ');
    const id = CATEGORIES[k] ?? CATEGORY_ALIASES[k];
    if (id === undefined) throw new Error(`Unknown category "${raw}". Use a Google Trends category ID (e.g. 71) or a name: ${Object.keys(CATEGORIES).join(', ')}.`);
    return id;
}

/** Search property: web search (default), image, news, shopping (froogle) or YouTube. */
export function normalizeProperty(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    const map = { '': '', web: '', websearch: '', 'web search': '', images: 'images', image: 'images', news: 'news', shopping: 'froogle', froogle: 'froogle', youtube: 'youtube' };
    if (!(s in map)) throw new Error(`Unknown search type "${raw}". Use web, images, news, shopping or youtube.`);
    return map[s];
}

/** geo: "", "US", "us", "US-CA" (state), "GB-ENG"; country names via the supplied resolver. */
export function normalizeGeo(raw, countryByName) {
    const s = String(raw ?? '').trim();
    if (!s || /^(world|worldwide|global)$/i.test(s)) return '';
    if (/^[A-Za-z]{2}(-[A-Za-z0-9]{1,3}){0,2}$/.test(s)) return s.toUpperCase().replace(/^UK\b/, 'GB'); // Google uses GB, people type UK
    const iso = countryByName(s);
    if (!iso) throw new Error(`Unknown location "${s}". Use a country code (US, IN, GB), a region code (US-CA) or a country name (united_states).`);
    return iso;
}

// ---------- explore ----------
export function exploreUrl(items, { category, property, hl = 'en-US', tz = 0 }) {
    const req = { comparisonItem: items.map((i) => ({ keyword: i.keyword, geo: i.geo, time: i.time })), category, property };
    return `${TRENDS}/trends/api/explore?${new URLSearchParams({ hl, tz: String(tz), req: JSON.stringify(req) })}`;
}
const WIDGET_PATH = { TIMESERIES: 'multiline', GEO_MAP: 'comparedgeo', RELATED_QUERIES: 'relatedsearches', RELATED_TOPICS: 'relatedsearches' };
/** Explore answer -> widgets grouped: {timeseries, geo[], queries[], topics[], userType} (index = keyword position). */
export function widgetsOf(explore) {
    const out = { timeseries: null, geo: [], queries: [], topics: [], userType: null };
    for (const w of explore?.widgets ?? []) {
        out.userType = out.userType ?? w.request?.userConfig?.userType ?? null;
        const m = w.id.match(/^(TIMESERIES|GEO_MAP|RELATED_QUERIES|RELATED_TOPICS)(?:_(\d+))?$/);
        if (!m) continue;
        const idx = m[2] === undefined ? null : Number(m[2]);
        if (m[1] === 'TIMESERIES') out.timeseries = w;
        else if (m[1] === 'GEO_MAP') {
            if (idx === null) out.geoCompared = w;
            else out.geo[idx] = w;
        }
        else if (m[1] === 'RELATED_QUERIES') out.queries[idx ?? 0] = w;
        else out.topics[idx ?? 0] = w;
    }
    if (!out.geo.length && out.geoCompared) out.geo[0] = out.geoCompared; // single keyword: the only map is its own
    return out;
}
export function widgetUrl(w, { hl = 'en-US', tz = 0, resolution } = {}) {
    const type = w.id.replace(/_\d+$/, '');
    const req = resolution ? { ...w.request, resolution } : w.request;
    return `${TRENDS}/trends/api/widgetdata/${WIDGET_PATH[type]}?${new URLSearchParams({ hl, tz: String(tz), req: JSON.stringify(req), token: w.token })}`;
}

// ---------- widget data ----------
const iso = (sec, withTime) => {
    const d = new Date(Number(sec) * 1000).toISOString();
    return withTime ? d.slice(0, 16).replace('T', ' ') : d.slice(0, 10);
};
/** multiline -> per keyword {dates, values, partial} (hourly timeframes keep the time). */
export function parseTimeline(json, count, { hourly = false } = {}) {
    const tl = json?.default?.timelineData ?? [];
    const dates = tl.map((p) => iso(p.time, hourly));
    return Array.from({ length: count }, (_, i) => ({
        dates,
        values: tl.map((p) => (p.hasData?.[i] === false ? 0 : Number(p.value?.[i] ?? 0))),
        partial_last_point: Boolean(tl.at(-1)?.isPartial),
    }));
}
/** comparedgeo -> [{region, geo_code, value}] (cities carry coordinates). */
export function parseRegions(json, { includeEmpty = false, index = 0 } = {}) {
    return (json?.default?.geoMapData ?? [])
        .filter((g) => includeEmpty || g.hasData?.[index] !== false)
        .map((g) => ({ region: g.geoName, geo_code: g.geoCode ?? null, value: Number(g.value?.[index] ?? 0), ...(g.coordinates ? { coordinates: g.coordinates } : {}) }))
        .sort((a, b) => b.value - a.value);
}
const fullLink = (l) => (l ? (l.startsWith('http') ? l : `${TRENDS.replace(/^http:\/\/127[^/]+/, 'https://trends.google.com')}${l}`) : null);
/** relatedsearches -> {top, rising}. Rising values are % growth; "Breakout" means > 5000 %. */
export function parseRelated(json, kind) {
    const lists = json?.default?.rankedList ?? [];
    const map = (k) => {
        const breakout = /breakout/i.test(k.formattedValue ?? '');
        const base = kind === 'topics'
            ? { topic: k.topic?.title ?? null, topic_type: k.topic?.type ?? null, mid: k.topic?.mid ?? null }
            : { query: k.query };
        return { ...base, value: breakout ? 'Breakout' : Number(k.value), formatted_value: k.formattedValue ?? String(k.value), link: fullLink(k.link) };
    };
    return { top: (lists[0]?.rankedKeyword ?? []).map(map), rising: (lists[1]?.rankedKeyword ?? []).map(map) };
}

/** avg / peak / latest / change / direction for one series. */
export function summarize({ dates, values, partial_last_point: partial }) {
    const v = partial && values.length > 1 ? values.slice(0, -1) : values; // the unfinished last point would skew the trend
    const d = partial && dates.length > 1 ? dates.slice(0, -1) : dates;
    if (!v.length) return null;
    const avg = v.reduce((s, x) => s + x, 0) / v.length;
    const peak = Math.max(...v);
    const q = Math.max(1, Math.floor(v.length / 4));
    const first = v.slice(0, q).reduce((s, x) => s + x, 0) / q;
    const last = v.slice(-q).reduce((s, x) => s + x, 0) / q;
    const change = first > 0 ? Math.round(((last - first) / first) * 100) : last > 0 ? 100 : 0;
    return {
        avg_interest: Math.round(avg),
        peak_interest: peak,
        peak_date: d[v.indexOf(peak)] ?? null,
        latest_interest: v.at(-1),
        change_pct: change,
        trend_direction: change >= 10 ? 'rising' : change <= -10 ? 'falling' : 'stable',
        zero_points: v.filter((x) => x === 0).length,
        points: v.length,
    };
}

/**
 * Puts keywords from several 5-keyword batches on one scale: each later batch repeats an anchor keyword from the
 * first batch, and its values are multiplied by (anchor avg in batch 1) / (anchor avg in that batch). The result is
 * rescaled so the overall peak is 100.
 */
export function scaleBatches(batches) {
    const ref = batches[0];
    const anchorAvg = (b) => b.series[b.anchorIndex].values.reduce((s, x) => s + x, 0) / Math.max(1, b.series[b.anchorIndex].values.length);
    const refAvg = anchorAvg(ref);
    const scaled = [];
    for (const b of batches) {
        const a = anchorAvg(b);
        const factor = b === ref ? 1 : a > 0 && refAvg > 0 ? refAvg / a : null;
        b.series.forEach((s, i) => {
            if (b !== ref && i === b.anchorIndex) return; // the anchor's own row comes from the first batch
            scaled.push({ keyword: b.keywords[i], dates: s.dates, raw: s.values, values: factor === null ? s.values : s.values.map((x) => x * factor), comparable: factor !== null, partial_last_point: s.partial_last_point });
        });
    }
    const max = Math.max(1, ...scaled.filter((s) => s.comparable).flatMap((s) => s.values));
    for (const s of scaled) if (s.comparable) s.values = s.values.map((x) => Math.round((x / max) * 10000) / 100); // 2 decimals keep small keywords visible next to big ones
    return scaled;
}

// ---------- trending now (RSS) ----------
const tag = (x, t) => (x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
const ent = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export function parseTrendingRss(xml, country) {
    return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m, i) => {
        const x = m[1];
        const traffic = tag(x, 'ht:approx_traffic');
        return {
            type: 'trending',
            country,
            rank: i + 1,
            query: ent(tag(x, 'title')),
            approx_traffic: traffic || null,
            traffic_min: Number(traffic.replace(/[^\d]/g, '')) || null,
            started_at: tag(x, 'pubDate') ? new Date(tag(x, 'pubDate')).toISOString() : null,
            picture: ent(tag(x, 'ht:picture')) || null,
            picture_source: ent(tag(x, 'ht:picture_source')) || null,
            news: [...x.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].map((n) => ({
                title: ent(tag(n[1], 'ht:news_item_title')), url: ent(tag(n[1], 'ht:news_item_url')), source: ent(tag(n[1], 'ht:news_item_source')) || null, picture: ent(tag(n[1], 'ht:news_item_picture')) || null,
            })),
            explore_url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(ent(tag(x, 'title')))}&geo=${country}&date=now%201-d`,
        };
    });
}
