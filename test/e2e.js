// End-to-end tests: the real actor against a fake Google Trends. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-trends.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICING = JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { result: { eventPriceUsd: 0.0025, eventTitle: 'r' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);

async function run(name, input, mock, env = {}) {
    const dir = join(ROOT, 'storage-test', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
    const child = spawn('node', ['src/main.js'], { cwd: ROOT, env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', APIFY_PROXY_PASSWORD: '', TRENDS_BASE: mock.base, HTTP_RATE_SCALE: '100', HTTP_BACKOFF_SCALE: '0.01', CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0', ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true', APIFY_ACTOR_PRICING_INFO: PRICING, APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}', ...env } });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    const rows = readDir(join(dir, 'datasets', 'default'));
    const charged = readDir(join(dir, 'datasets', 'charging_log')).reduce((s, c) => s + (c.chargedCount ?? 1), 0);
    const sf = join(dir, 'key_value_stores', 'default', 'RUN_SUMMARY.json');
    return { code, rows, kw: rows.filter((r) => r.type === 'keyword'), tr: rows.filter((r) => r.type === 'trending'), charged, summary: existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : null, logs };
}
const results = [];
const check = (label, pass, detail = '') => {
    results.push(Boolean(pass));
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);

if (want('separately')) {
    console.log('\n=== 1. SEPARATELY: full row per keyword ===');
    const mock = await startMock();
    const r = await run('separately', { keywords: ['Pizza', 'pizza', 'burger', 'zzz nothing'], timeframe: '12m', geo: 'united_states', maxRelated: 10, maxRegions: 2 }, mock);
    const p = r.kw.find((x) => x.keyword === 'Pizza');
    check('duplicates removed (first spelling kept); one row per keyword', r.kw.length === 3 && p, r.kw.map((x) => x.keyword).join(','));
    check('original fields: interest_over_time {dates, values}, interest_by_region, related_queries {top, rising}, related_topics, summary', p.interest_over_time.dates.length === 52 && p.interest_over_time.values.length === 52 && Array.isArray(p.interest_by_region) && p.related_queries.top.length === 10 && p.related_queries.rising[0].value === 'Breakout' && 'related_topics' in p && p.summary.trend_direction);
    check('timeframe alias 12m -> today 12-m; geo name -> US; partial last week excluded from summary', p.timeframe === 'today 12-m' && p.geo === 'US' && p.interest_over_time.partial_last_point === true && p.summary.points === 51);
    check('regions sorted, low-volume region left out, capped at 2', p.interest_by_region.length === 2 && p.interest_by_region[0].value >= p.interest_by_region[1].value && !p.interest_by_region.some((x) => x.value === 0));
    check('Google hides topics from this IP -> related_topics_status says so', p.related_topics_status === 'withheld_by_google' && r.summary.relatedTopics.withheld === 2);
    const z = r.kw.find((x) => x.keyword === 'zzz nothing');
    check('keyword without data: success false, error, NOT charged', z.success === false && /Not enough search volume/.test(z.error) && r.charged === 2, `charged ${r.charged}`);
    check('NID cookie fetched first (no cookie-less 429s)', mock.hits.noCookie === 0, JSON.stringify(mock.hits));
    mock.close();
}

if (want('topics')) {
    console.log('\n=== 2. HIDDEN TOPICS recovered through a residential IP ===');
    const mock = await startMock();
    const r = await run('topics', { keywords: ['pizza'], geo: 'US' }, mock, { TEST_RESIDENTIAL_PROXY_URL: mock.residentialProxyUrl });
    const p = r.kw[0];
    check('topics fetched via the residential route: top + rising (Breakout), status ok', p.related_topics_status === 'ok' && p.related_topics.top[0].topic === 'Pizza' && p.related_topics.top[0].topic_type === 'Dish' && p.related_topics.rising[0].value === 'Breakout' && r.summary.relatedTopics.recoveredViaResidential === 1);
    mock.close();
}

if (want('together')) {
    console.log('\n=== 3. TOGETHER: 8 keywords on one scale (anchor batches) ===');
    const mock = await startMock();
    const r = await run('together', { keywords: ['pizza', 'burger', 'sushi', 'tacos', 'pasta', 'ramen', 'biryani', 'falafel'], compareMode: 'together', regionResolution: 'DMA', includeRelatedTopics: false }, mock);
    const by = Object.fromEntries(r.kw.map((x) => [x.keyword, x]));
    check('8 rows, 2 explore calls (5 + anchor and 3)', r.kw.length === 8 && mock.hits.explore === 2, `${mock.hits.explore} explores`);
    check('shared scale: the busiest keyword peaks at 100; later batches stay in proportion', by.pizza.summary.peak_interest === 100 && by.ramen.summary.avg_interest < by.burger.summary.avg_interest && by.falafel.summary.avg_interest <= by.biryani.summary.avg_interest + 1, `pizza ${by.pizza.summary.avg_interest}, burger ${by.burger.summary.avg_interest}, ramen ${by.ramen.summary.avg_interest}, falafel ${by.falafel.summary.avg_interest}`);
    check('small keywords keep decimals instead of rounding to 0 (still success)', by.falafel.success && by.falafel.interest_over_time.values.some((v) => v > 0 && v < 5));
    check('anchor + compared_with + metro regions', by.ramen.anchor_keyword === 'pizza' && by.ramen.compared_with.length === 7 && by.pizza.interest_by_region[0].region === 'New York NY');
    mock.close();
}

if (want('trending')) {
    console.log('\n=== 4. TRENDING NOW + trending-only run ===');
    const mock = await startMock();
    const r = await run('trending', { includeTrending: true, trendingCountry: 'united_states, india', maxTrendingPerCountry: 3 }, mock);
    check('trending-only run: 3 per country, charged per row', r.tr.length === 6 && r.charged === 6 && r.tr[0].country === 'US' && r.tr[3].country === 'IN');
    check('fields: rank, query (entities decoded), approx_traffic, traffic_min, started_at, picture, news', r.tr[0].rank === 1 && r.tr[0].query === 'US trend 0 & more' && r.tr[0].traffic_min === 1000 && r.tr[0].started_at.startsWith('2026-10-28') && r.tr[0].news[0].url === 'https://news/0');
    mock.close();
}

if (want('robust')) {
    console.log('\n=== 5. RATE LIMITS, INPUT ERRORS, LIMITS ===');
    const mock = await startMock({ rateLimitFirst: 3 });
    const r = await run('ratelimit', { keywords: ['pizza', 'burger'], includeRelatedTopics: false }, mock);
    check('429 answers retried with a fresh session, nothing lost', r.kw.length === 2 && r.kw.every((x) => x.success) && mock.hits.rateLimited === 3, JSON.stringify(r.summary?.requests));
    mock.close();
    const m2 = await startMock();
    const bad = await run('badtime', { keywords: ['x'], timeframe: 'last fortnight' }, m2);
    check('invalid timeframe -> INVALID_INPUT row + clear failure', bad.code !== 0 && bad.rows[0]?.errorCode === 'INVALID_INPUT' && /Unknown timeframe/.test(bad.rows[0].error));
    const none = await run('noinput', {}, m2);
    check('no keywords and no trending -> failure', none.code !== 0);
    const cat = await run('category', { keywords: ['pizza'], category: 'food & drink', searchType: 'youtube', includeRelatedTopics: false }, m2);
    check('category name -> 71, search type youtube, explore_url carries both', cat.kw[0].category === 71 && cat.kw[0].search_type === 'youtube' && /cat=71/.test(cat.kw[0].explore_url) && /gprop=youtube/.test(cat.kw[0].explore_url));
    const cap = await run('maxcost', { keywords: ['a1', 'b2', 'c3', 'd4', 'e5'], includeRelatedTopics: false }, m2, { ACTOR_MAX_TOTAL_CHARGE_USD: '2', APIFY_ACTOR_PRICING_INFO: PRICING.replace('0.0025', '1') });
    check('max cost per run respected ($1 per row, $2 limit -> 2 rows)', cap.charged === 2 && cap.summary.stopReason === 'max_cost_per_run_reached', `${cap.charged} charged`);
    m2.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
