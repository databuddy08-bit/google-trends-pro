// Unit tests on real Google Trends answers (test/fixtures). `npm test`
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parseXssi, normalizeTimeframe, normalizeCategory, normalizeProperty, normalizeGeo, exploreUrl, widgetsOf, widgetUrl,
    parseTimeline, parseRegions, parseRelated, summarize, scaleBatches, parseTrendingRss,
} from '../src/trends.js';
import { countryCode, countryName } from '../src/countries.js';

const fx = (f) => readFileSync(new URL(`fixtures/${f}`, import.meta.url), 'utf8');

test('parseXssi strips the )]}\' prefix and rejects HTML', () => {
    assert.deepEqual(parseXssi(")]}'\n{\"a\":1}"), { a: 1 });
    assert.throws(() => parseXssi('<html>429</html>'));
});

test('timeframe: Google strings, aliases, custom ranges, errors', () => {
    assert.equal(normalizeTimeframe(''), 'today 12-m');
    assert.equal(normalizeTimeframe('90d'), 'today 3-m');
    assert.equal(normalizeTimeframe('7d'), 'now 7-d');
    assert.equal(normalizeTimeframe('5y'), 'today 5-y');
    assert.equal(normalizeTimeframe('Today 3-M'), 'today 3-m');
    assert.equal(normalizeTimeframe('now 1-h'), 'now 1-H');
    assert.equal(normalizeTimeframe('all'), 'all');
    assert.equal(normalizeTimeframe('2024-01-01 2024-06-30'), '2024-01-01 2024-06-30');
    assert.throws(() => normalizeTimeframe('2003-01-01 2004-06-30'), /2004-01-01/);
    assert.throws(() => normalizeTimeframe('2024-06-30 2024-01-01'), /before/);
    assert.throws(() => normalizeTimeframe('last fortnight'), /Unknown timeframe/);
});

test('category by id, name or alias; search type; geo', () => {
    assert.equal(normalizeCategory(''), 0);
    assert.equal(normalizeCategory(71), 71);
    assert.equal(normalizeCategory('Food and Drink'), 71);
    assert.equal(normalizeCategory('tech'), 5);
    assert.throws(() => normalizeCategory('spaceships'), /Unknown category/);
    assert.equal(normalizeProperty('YouTube'), 'youtube');
    assert.equal(normalizeProperty('shopping'), 'froogle');
    assert.equal(normalizeProperty(''), '');
    assert.throws(() => normalizeProperty('tiktok'));
    assert.equal(normalizeGeo('', countryCode), '');
    assert.equal(normalizeGeo('worldwide', countryCode), '');
    assert.equal(normalizeGeo('us-ca', countryCode), 'US-CA');
    assert.equal(normalizeGeo('united_states', countryCode), 'US');
    assert.equal(normalizeGeo('India', countryCode), 'IN');
    assert.equal(normalizeGeo('uk', countryCode), 'GB');
    assert.throws(() => normalizeGeo('Atlantis', countryCode), /Unknown location/);
    assert.equal(countryName('DE'), 'Germany');
});

test('explore answers -> widgets (compare and single keyword)', () => {
    const c = widgetsOf(parseXssi(fx('explore-compare.txt')));
    assert.equal(c.userType, 'USER_TYPE_SCRAPER');
    assert.ok(c.timeseries && c.geoCompared);
    assert.equal(c.geo.length, 2);
    assert.equal(c.queries.length, 2);
    assert.match(widgetUrl(c.geo[1], { resolution: 'DMA' }), /widgetdata\/comparedgeo\?.*DMA/);
    assert.match(widgetUrl(c.queries[0]), /widgetdata\/relatedsearches\?/);
    const s = widgetsOf(parseXssi(fx('explore-single.txt')));
    assert.equal(s.geo.length, 1, 'the only map belongs to the single keyword');
    assert.equal(s.topics.length, 1);
    assert.equal(s.queries.length, 1);
    const u = new URL(exploreUrl([{ keyword: 'pizza', geo: 'US', time: 'today 3-m' }], { category: 71, property: 'youtube' }));
    assert.deepEqual(JSON.parse(u.searchParams.get('req')), { comparisonItem: [{ keyword: 'pizza', geo: 'US', time: 'today 3-m' }], category: 71, property: 'youtube' });
});

test('timeline, regions, cities, related queries', () => {
    const [s] = parseTimeline(parseXssi(fx('multiline.json')), 1);
    assert.equal(s.dates.length, 53);
    assert.equal(s.values.length, 53);
    assert.match(s.dates[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(s.partial_last_point, true);
    const regions = parseRegions(parseXssi(fx('comparedgeo-region.json')));
    assert.equal(regions.length, 51);
    assert.equal(regions[0].value, 100);
    assert.ok(regions.every((r, i) => i === 0 || regions[i - 1].value >= r.value));
    assert.match(regions[0].geo_code, /^US-/);
    const city = parseRegions(parseXssi(fx('comparedgeo-city.json')));
    assert.ok(city[0].coordinates.lat);
    const q = parseRelated(parseXssi(fx('relatedsearches-queries.json')), 'queries');
    assert.ok(q.top.length > 10 && q.rising.length > 5);
    assert.equal(q.top[0].value, 100);
    assert.match(q.top[0].link, /^https:\/\/trends\.google\.com\/trends\/explore\?q=/);
    assert.ok(q.rising.every((r) => r.value === 'Breakout' || Number.isFinite(r.value)));
});

test('summary skips the unfinished last point', () => {
    const sm = summarize({ dates: ['a', 'b', 'c', 'd', 'e'], values: [10, 10, 20, 40, 1], partial_last_point: true });
    assert.equal(sm.points, 4);
    assert.equal(sm.latest_interest, 40);
    assert.equal(sm.peak_interest, 40);
    assert.equal(sm.peak_date, 'd');
    assert.equal(sm.trend_direction, 'rising');
    assert.equal(summarize({ dates: ['a', 'b', 'c', 'd'], values: [50, 50, 50, 50] }).trend_direction, 'stable');
    assert.equal(summarize({ dates: ['a', 'b', 'c', 'd'], values: [80, 60, 40, 20] }).trend_direction, 'falling');
});

test('scaleBatches puts batches on one scale through the anchor', () => {
    const d = ['x', 'y'];
    const b0 = { keywords: ['big', 'mid'], anchorIndex: 0, series: [{ dates: d, values: [100, 100] }, { dates: d, values: [50, 50] }] };
    // In batch 2 the anchor reads 100 too, but "small" is 1/4 of the anchor -> 25 on the shared scale.
    const b1 = { keywords: ['big', 'small', 'tiny'], anchorIndex: 0, series: [{ dates: d, values: [100, 100] }, { dates: d, values: [25, 25] }, { dates: d, values: [1, 0] }] };
    const out = Object.fromEntries(scaleBatches([b0, b1]).map((s) => [s.keyword, s]));
    assert.deepEqual(Object.keys(out), ['big', 'mid', 'small', 'tiny'], 'anchor appears once');
    assert.deepEqual(out.small.values, [25, 25]);
    assert.deepEqual(out.tiny.raw, [1, 0]);
    // Anchor weaker in batch 2 (reads 50): everything there doubles.
    const b2 = { keywords: ['big', 'other'], anchorIndex: 0, series: [{ dates: d, values: [50, 50] }, { dates: d, values: [10, 10] }] };
    const out2 = Object.fromEntries(scaleBatches([b0, b2]).map((s) => [s.keyword, s]));
    assert.deepEqual(out2.other.values, [20, 20]);
    // Anchor without data in a batch: rows keep their own scale and say so.
    const b3 = { keywords: ['big', 'lonely'], anchorIndex: 0, series: [{ dates: d, values: [0, 0] }, { dates: d, values: [100, 0] }] };
    assert.equal(scaleBatches([b0, b3]).find((s) => s.keyword === 'lonely').comparable, false);
});

test('trending RSS -> rows', () => {
    const rows = parseTrendingRss(fx('trending-rss.xml'), 'US');
    assert.equal(rows.length, 10);
    const r = rows[0];
    assert.equal(r.type, 'trending');
    assert.equal(r.rank, 1);
    assert.ok(r.query && r.approx_traffic && r.traffic_min > 0);
    assert.ok(!Number.isNaN(Date.parse(r.started_at)));
    assert.ok(r.news.length && r.news[0].url.startsWith('http'));
    assert.match(r.explore_url, /geo=US/);
});
