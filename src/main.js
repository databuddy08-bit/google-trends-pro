// Google Trends Pro — Apify actor entry point. Interest over time, regions, related queries/topics, trending now.
import { Actor, log } from 'apify';
import { Client, Session, BlockedError, StoppedError, JSON_HEADERS, HTML_HEADERS, RSS_HEADERS } from './http.js';
import {
    TRENDS, parseXssi, normalizeTimeframe, normalizeCategory, normalizeProperty, normalizeGeo, exploreUrl, widgetsOf, widgetUrl,
    parseTimeline, parseRegions, parseRelated, summarize, scaleBatches, parseTrendingRss,
} from './trends.js';
import { countryCode, countryName } from './countries.js';

// Pay-per-event name — must match the Monetization settings exactly.
export const EVENT_RESULT = 'result'; // one keyword with data, or one trending search

const KEYWORD_CONCURRENCY = 3;
const STOP_BEFORE_TIMEOUT_MS = 45000;
const BATCH = 5; // Google compares up to 5 keywords at once
const INT32 = 2147483647;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const num = (v, d, min, max) => Math.min(max, INT32, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : []).map((x) => String(x ?? '').trim()).filter(Boolean);

let opts;
try {
    const timeframe = normalizeTimeframe(input.timeframe);
    opts = {
        keywords: list(input.keywords).filter((k, i, a) => a.findIndex((x) => x.toLowerCase() === k.toLowerCase()) === i), // first spelling wins
        timeframe,
        hourly: /^now /.test(timeframe),
        geo: normalizeGeo(input.geo, countryCode),
        category: normalizeCategory(input.category),
        property: normalizeProperty(input.searchType ?? input.property),
        compareMode: input.compareMode === 'together' ? 'together' : 'separately',
        includeTimeline: input.includeInterestOverTime !== false,
        includeRegions: input.includeInterestByRegion !== false,
        resolution: ['COUNTRY', 'REGION', 'DMA', 'CITY'].includes(String(input.regionResolution ?? '').toUpperCase()) ? String(input.regionResolution).toUpperCase() : null,
        includeEmptyRegions: Boolean(input.includeLowVolumeRegions),
        maxRegions: num(input.maxRegions, 0, 0, 10000),
        includeQueries: input.includeRelatedQueries !== false,
        includeTopics: input.includeRelatedTopics !== false,
        maxRelated: num(input.maxRelated, 25, 1, 25),
        retryTopicsWithResidential: input.retryTopicsWithResidential !== false,
        includeTrending: Boolean(input.includeTrending),
        trendingCountries: list(input.trendingCountry ?? input.trendingCountries ?? 'united_states'),
        maxTrending: num(input.maxTrendingPerCountry, 0, 0, 1000),
        hl: String(input.language || 'en-US'),
        tz: num(input.timezoneOffsetMinutes, 0, -840, 840),
        maxItems: num(input.maxItems, 0, 0, INT32),
    };
    opts.trendingGeo = opts.trendingCountries.map((c) => {
        const iso = countryCode(c);
        if (!iso) throw new Error(`Unknown trending country "${c}". Use united_states, india, united_kingdom… or a country code (US, IN, GB).`);
        return iso;
    });
} catch (err) {
    await Actor.pushData({ type: 'error', success: false, error: err.message, errorCode: 'INVALID_INPUT' });
    await Actor.fail(err.message);
}
if (!opts.keywords.length && !opts.includeTrending) {
    await Actor.pushData({ type: 'error', success: false, error: 'No keywords and trending searches are off', errorCode: 'INVALID_INPUT' });
    await Actor.fail('Add at least one keyword, or turn on "Include trending searches".');
}

// ---------- Deadline, routes, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return stopReason ? 0 : deadline - Date.now();
};

const proxyInput = input.proxyConfiguration ?? input.proxy;
let userProxy;
if (proxyInput?.useApifyProxy || proxyInput?.proxyUrls?.length) {
    try {
        userProxy = await Actor.createProxyConfiguration(proxyInput);
    } catch (err) {
        log.warning(`Proxy could not be configured (${err.message}). Continuing without it.`);
    }
}
const groups = proxyInput?.apifyProxyGroups ?? [];
const userLabel = !userProxy ? 'no proxy (server IP)' : proxyInput?.useApifyProxy ? `Apify proxy (${groups.length ? groups.join(', ') : 'datacenter'})` : 'custom proxy';
const routes = [{ label: userLabel, proxy: userProxy }];
let residentialRoute = groups.includes('RESIDENTIAL') ? routes[0] : null;
if (input.proxyFallback !== false && (Actor.isAtHome() || process.env.APIFY_PROXY_PASSWORD)) {
    for (const g of [[], ['RESIDENTIAL']]) {
        const label = `Apify proxy (${g.length ? g[0] : 'datacenter'})`;
        if (label === userLabel) continue;
        try {
            const pc = await Actor.createProxyConfiguration({ useApifyProxy: true, ...(g.length ? { apifyProxyGroups: g } : {}) });
            if (pc) {
                routes.push({ label, proxy: pc });
                if (g.length) residentialRoute = routes.at(-1);
            }
        } catch { /* group not available */ }
    }
    if (userProxy) routes.push({ label: 'no proxy (server IP)', proxy: undefined });
}
if (process.env.TEST_RESIDENTIAL_PROXY_URL) residentialRoute = { label: 'test residential', proxy: { newUrl: async () => process.env.TEST_RESIDENTIAL_PROXY_URL } };
const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null,
    settings: { timeframe: opts.timeframe, geo: opts.geo || 'worldwide', category: opts.category, searchType: opts.property || 'web', compareMode: opts.compareMode },
    keywords: opts.keywords.length, keywordRows: 0, keywordsWithoutData: 0, trendingRows: 0, charged: 0, failed: 0,
    relatedTopics: { withheld: 0, recoveredViaResidential: 0 }, skipReasons: {}, requests: { requests: 0, blocked: 0, networkErrors: 0 }, routes: [],
};
const client = new Client({ routes, msLeft, stats: summary.requests });
const topicsClient = residentialRoute && opts.retryTopicsWithResidential ? new Client({ routes: [residentialRoute], msLeft, stats: summary.requests }) : null;
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();
log.info(`${opts.keywords.length} keyword(s), ${opts.timeframe}, ${opts.geo || 'worldwide'}, category ${opts.category}, ${opts.property || 'web'} search, ${opts.compareMode}${opts.includeTrending ? `, trending: ${opts.trendingGeo.join(', ')}` : ''}. Routes: ${routes.map((r) => r.label).join(' → ')}`);

// ---------- Output ----------
let chain = Promise.resolve();
let saved = 0;
function save(row, charge) {
    const p = chain.then(async () => {
        if (stopReason && charge) return false;
        if (charge && opts.maxItems && saved >= opts.maxItems) {
            stop('max_items_reached');
            return false;
        }
        if (charge && pricing.isPayPerEvent && charging.calculateMaxEventChargeCountWithinLimit(EVENT_RESULT) <= 0) {
            stop('max_cost_per_run_reached');
            return false;
        }
        row.scrapedAt = new Date().toISOString();
        if (charge) {
            const res = await Actor.pushData(row, EVENT_RESULT);
            summary.charged += res?.chargedCount ?? 0;
            saved += 1;
            if (res?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        } else await Actor.pushData(row); // rows without data and errors are free
        return true;
    });
    chain = p.then(() => {}, () => {});
    return p;
}

// ---------- Google Trends calls ----------
const isJsonAnswer = (res) => (res.statusCode === 200 && typeof res.body === 'string' && !res.body.trimStart().startsWith(")]}'") && !res.body.trimStart().startsWith('{') ? 'unexpected answer (not Trends JSON)' : null);
/** Sessions need Google's NID cookie (from the Trends home page) or Trends answers 429. */
async function warm(session, c) {
    if (session.jar.getCookieStringSync(TRENDS).includes('NID=')) return;
    try {
        await c.fetch({ url: `${TRENDS}/trends/?geo=${opts.geo.slice(0, 2) || 'US'}`, headers: HTML_HEADERS, attempts: 2 }, session);
    } catch (err) {
        if (err instanceof StoppedError) throw err;
    }
}
async function trendsJson(url, session, c = client) {
    const res = await c.fetch({ url, headers: JSON_HEADERS, isBlocked: isJsonAnswer, prepare: async (s) => { await warm(s, c); return {}; } }, session);
    if (res.status === 400 || res.status === 404) throw Object.assign(new Error(`Google Trends rejected the request (HTTP ${res.status})`), { code: 'BAD_REQUEST' });
    return parseXssi(res.body);
}
const exploreLink = (kws) => `https://trends.google.com/trends/explore?${new URLSearchParams({ q: kws.join(','), date: opts.timeframe, ...(opts.geo ? { geo: opts.geo } : {}), ...(opts.category ? { cat: String(opts.category) } : {}), ...(opts.property ? { gprop: opts.property } : {}) })}`;
const cut = (arr, n) => (n ? arr.slice(0, n) : arr);

/** Regions, related queries and topics for keyword i of an explore. */
async function details(w, i, keyword, session) {
    const out = {};
    if (opts.includeRegions && w.geo[i]) {
        const j = await trendsJson(widgetUrl(w.geo[i], { hl: opts.hl, tz: opts.tz, resolution: opts.resolution ?? undefined }), session);
        out.interest_by_region = cut(parseRegions(j, { includeEmpty: opts.includeEmptyRegions }), opts.maxRegions);
        out.region_resolution = opts.resolution ?? w.geo[i].request?.resolution ?? null;
    }
    if (opts.includeQueries && w.queries[i]) {
        const r = parseRelated(await trendsJson(widgetUrl(w.queries[i], { hl: opts.hl, tz: opts.tz }), session), 'queries');
        out.related_queries = { top: r.top.slice(0, opts.maxRelated), rising: r.rising.slice(0, opts.maxRelated) };
    }
    if (opts.includeTopics) {
        let r = w.topics[i] ? parseRelated(await trendsJson(widgetUrl(w.topics[i], { hl: opts.hl, tz: opts.tz }), session), 'topics') : { top: [], rising: [] };
        let status = r.top.length || r.rising.length ? 'ok' : 'empty';
        if (status === 'empty' && w.userType === 'USER_TYPE_SCRAPER') {
            status = 'withheld_by_google';
            summary.relatedTopics.withheld += 1;
            if (topicsClient) { // Google hides topics from IPs it flags as automated; a residential IP usually gets them
                try {
                    const s2 = new Session();
                    const e2 = widgetsOf(await trendsJson(exploreUrl([{ keyword, geo: opts.geo, time: opts.timeframe }], { category: opts.category, property: opts.property, hl: opts.hl, tz: opts.tz }), s2, topicsClient));
                    if (e2.topics[0]) {
                        const r2 = parseRelated(await trendsJson(widgetUrl(e2.topics[0], { hl: opts.hl, tz: opts.tz }), s2, topicsClient), 'topics');
                        if (r2.top.length || r2.rising.length) {
                            r = r2;
                            status = 'ok';
                            summary.relatedTopics.recoveredViaResidential += 1;
                        }
                    }
                } catch (err) {
                    if (err instanceof StoppedError) throw err;
                    log.debug(`Residential topics retry failed for "${keyword}": ${err.message}`);
                }
            }
        }
        out.related_topics = { top: r.top.slice(0, opts.maxRelated), rising: r.rising.slice(0, opts.maxRelated) };
        out.related_topics_status = status;
    }
    return out;
}

function keywordRow(keyword, series, extra) {
    const hasData = series ? (series.raw ?? series.values).some((v) => v > 0) : (extra.related_queries?.top?.length ?? 0) > 0;
    const row = {
        type: 'keyword',
        keyword,
        success: hasData,
        timeframe: opts.timeframe,
        geo: opts.geo,
        geo_name: opts.geo ? (opts.geo.length === 2 ? countryName(opts.geo) : opts.geo) : 'Worldwide',
        category: opts.category,
        search_type: opts.property || 'web',
        ...(series && opts.includeTimeline ? { interest_over_time: { dates: series.dates, values: series.values, ...(series.partial_last_point ? { partial_last_point: true } : {}) } } : {}),
        ...extra,
        summary: series ? summarize(series) : null,
        explore_url: exploreLink([keyword]),
    };
    if (!hasData) row.error = 'Not enough search volume for this keyword, timeframe and location';
    return row;
}

async function oneKeyword(keyword, session) {
    const e = widgetsOf(await trendsJson(exploreUrl([{ keyword, geo: opts.geo, time: opts.timeframe }], { category: opts.category, property: opts.property, hl: opts.hl, tz: opts.tz }), session));
    const series = e.timeseries ? parseTimeline(await trendsJson(widgetUrl(e.timeseries, { hl: opts.hl, tz: opts.tz }), session), 1, { hourly: opts.hourly })[0] : null;
    // No search volume: skip regions/queries/topics (saves requests, keeps the topics count honest).
    const hasData = series ? (series.raw ?? series.values).some((v) => v > 0) : true;
    const extra = hasData ? await details(e, 0, keyword, session) : {};
    return keywordRow(keyword, series, extra);
}

/** Together mode: batches of 5 sharing an anchor keyword, so every keyword ends up on one 0–100 scale. */
async function together(session) {
    const kws = opts.keywords;
    const batches = [];
    const first = kws.slice(0, BATCH);
    const runBatch = async (batchKws, anchorIndex) => {
        const e = widgetsOf(await trendsJson(exploreUrl(batchKws.map((k) => ({ keyword: k, geo: opts.geo, time: opts.timeframe })), { category: opts.category, property: opts.property, hl: opts.hl, tz: opts.tz }), session));
        const series = parseTimeline(await trendsJson(widgetUrl(e.timeseries, { hl: opts.hl, tz: opts.tz }), session), batchKws.length, { hourly: opts.hourly });
        return { keywords: batchKws, series, anchorIndex, widgets: e };
    };
    const b0 = await runBatch(first, 0);
    const avgs = b0.series.map((s) => s.values.reduce((a, x) => a + x, 0) / Math.max(1, s.values.length));
    // Anchor: the busiest keyword of the first batch keeps the scale stable in every later batch.
    b0.anchorIndex = avgs.indexOf(Math.max(...avgs));
    const anchor = first[b0.anchorIndex];
    batches.push(b0);
    for (let i = BATCH; i < kws.length && !stopReason; i += BATCH - 1) {
        const rest = kws.slice(i, i + BATCH - 1);
        batches.push(await runBatch([anchor, ...rest], 0));
    }
    const scaled = scaleBatches(batches);
    for (const s of scaled) {
        if (stopReason) break;
        const b = batches.find((x) => x.keywords.includes(s.keyword) && (x === batches[0] || s.keyword !== anchor));
        const idx = b.keywords.indexOf(s.keyword);
        let extra = {};
        try {
            extra = await details(b.widgets, idx, s.keyword, session);
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            extra = { details_error: err.message };
        }
        const row = keywordRow(s.keyword, { dates: s.dates, values: s.values, raw: s.raw, partial_last_point: s.partial_last_point }, extra);
        row.compared_with = opts.keywords.filter((k) => k !== s.keyword);
        row.scale = s.comparable ? 'shared (anchor keyword)' : 'own batch only (anchor had no data)';
        row.anchor_keyword = anchor;
        row.explore_url = exploreLink(b.keywords);
        await saveKeyword(row);
    }
}

async function saveKeyword(row) {
    summary.keywordRows += 1;
    if (!row.success) summary.keywordsWithoutData += 1;
    return save(row, row.success);
}

async function failRow(keyword, err) {
    summary.failed += 1;
    const blocked = err instanceof BlockedError;
    return save({ type: 'keyword', keyword, success: false, error: blocked ? `Google Trends kept refusing every route (${err.message}). Run again later or use the RESIDENTIAL proxy group.` : err.message, errorCode: blocked ? 'BLOCKED' : err.code ?? 'ERROR', timeframe: opts.timeframe, geo: opts.geo }, false);
}

// ---------- Run ----------
if (opts.keywords.length) {
    if (opts.compareMode === 'together') {
        try {
            await together(new Session());
        } catch (err) {
            if (!(err instanceof StoppedError)) {
                log.warning(`Comparison failed: ${err.message}`);
                for (const k of opts.keywords) await failRow(k, err);
            }
        }
    } else {
        const queue = [...opts.keywords];
        const work = async () => {
            const session = new Session();
            while (queue.length && !stopReason && msLeft() > 0) {
                const k = queue.shift();
                try {
                    await saveKeyword(await oneKeyword(k, session));
                } catch (err) {
                    if (err instanceof StoppedError) return;
                    log.warning(`"${k}": ${err.message}`);
                    await failRow(k, err);
                    session.rotate();
                }
                if (saved && saved % 25 === 0) log.info(`Progress: ${summary.keywordRows}/${opts.keywords.length} keywords.`);
            }
        };
        await Promise.all(Array.from({ length: Math.min(KEYWORD_CONCURRENCY, queue.length) }, work));
    }
}
if (opts.includeTrending && !stopReason) {
    for (const geo of opts.trendingGeo) {
        if (stopReason) break;
        try {
            const res = await client.fetch({ url: `${TRENDS}/trending/rss?geo=${geo}`, headers: RSS_HEADERS, isBlocked: (r) => (r.statusCode === 200 && !/<rss/.test(String(r.body).slice(0, 500)) ? 'not an RSS feed' : null) }, new Session());
            const rows = cut(parseTrendingRss(res.body, geo), opts.maxTrending);
            if (!rows.length) await save({ type: 'trending', country: geo, success: false, error: 'No trending searches published for this country right now' }, false);
            for (const r of rows) {
                if (!(await save({ ...r, country_name: countryName(geo), success: true }, true))) break;
                summary.trendingRows += 1;
            }
        } catch (err) {
            if (err instanceof StoppedError) break;
            await save({ type: 'trending', country: geo, success: false, error: err.message }, false);
        }
    }
}
await chain;

// ---------- Summary ----------
summary.stopReason = stopReason ?? 'completed';
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.routes = client.routesSummary();
await Actor.setValue('RUN_SUMMARY', summary);
const msg = `${summary.keywordRows - summary.keywordsWithoutData}/${opts.keywords.length} keywords with data${summary.trendingRows ? `, ${summary.trendingRows} trending searches` : ''}${summary.relatedTopics.withheld ? `, related topics withheld by Google for ${summary.relatedTopics.withheld - summary.relatedTopics.recoveredViaResidential}` : ''}. Stop reason: ${summary.stopReason}.`;
log.info(msg);
await Actor.exit({ statusMessage: msg });
