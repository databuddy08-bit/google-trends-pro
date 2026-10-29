// Fake Google Trends (shapes copied from real answers) + a fake "residential" proxy that gets related topics.
import http from 'node:http';

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const level = (k) => (k.startsWith('zzz') ? 0 : { pizza: 80, burger: 20, sushi: 18, tacos: 12, pasta: 15, ramen: 8, biryani: 3, falafel: 2 }[k] ?? 10 + (hash(k) % 60));

export async function startMock({ rateLimitFirst = 0 } = {}) {
    const hits = { explore: 0, rateLimited: 0, residentialTopics: 0, noCookie: 0 };
    let limited = rateLimitFirst;
    const handle = (req, res, viaResidential) => {
        const url = new URL(req.url, 'http://x');
        const send = (code, body, type = 'application/json; charset=utf-8', headers = {}) => { res.writeHead(code, { 'content-type': type, ...headers }); res.end(body); };
        const xssi = (o) => send(200, `)]}'\n${JSON.stringify(o)}`);
        const p = url.pathname;
        if (p === '/trends/' || p === '/trends') return send(200, '<html>trends</html>', 'text/html', { 'set-cookie': 'NID=abc123; Path=/; HttpOnly' });
        if (p.startsWith('/trends/api/') && !String(req.headers.cookie ?? '').includes('NID=')) { hits.noCookie += 1; return send(429, '<html>429 Too Many Requests</html>', 'text/html'); }
        if (p.startsWith('/trends/api/') && limited > 0) { limited -= 1; hits.rateLimited += 1; return send(429, '<html>429</html>', 'text/html'); }
        if (p === '/trends/api/explore') {
            hits.explore += 1;
            const r = JSON.parse(url.searchParams.get('req'));
            if (r.comparisonItem.length > 5) return send(400, '<html>400</html>', 'text/html');
            const userConfig = { userType: viaResidential ? 'USER_TYPE_LEGIT_USER' : 'USER_TYPE_SCRAPER' };
            const kws = r.comparisonItem.map((c) => c.keyword);
            const base = { time: r.comparisonItem[0].time, comparisonItem: kws.map((k) => ({ keyword: k })), requestOptions: { category: r.category, property: r.property }, userConfig };
            const widgets = [{ id: 'TIMESERIES', token: 'TS', request: { ...base, kws } }];
            if (kws.length === 1) {
                widgets.push({ id: 'GEO_MAP', token: 'GEO', request: { ...base, kw: kws[0], resolution: r.comparisonItem[0].geo ? 'REGION' : 'COUNTRY' } });
                widgets.push({ id: 'RELATED_TOPICS', token: 'TOP', request: { ...base, kw: kws[0] } });
                widgets.push({ id: 'RELATED_QUERIES', token: 'QRY', request: { ...base, kw: kws[0] } });
            } else {
                widgets.push({ id: 'GEO_MAP', token: 'GEO', request: { ...base, resolution: 'REGION' } });
                kws.forEach((k, i) => {
                    if (level(k) > 2) widgets.push({ id: `GEO_MAP_${i}`, token: 'GEO', request: { ...base, kw: k, resolution: 'REGION' } });
                    widgets.push({ id: `RELATED_QUERIES_${i}`, token: 'QRY', request: { ...base, kw: k } });
                });
            }
            return xssi({ widgets });
        }
        if (p.startsWith('/trends/api/widgetdata/')) {
            const w = JSON.parse(url.searchParams.get('req'));
            const token = url.searchParams.get('token');
            if (p.endsWith('/multiline')) {
                const kws = w.kws;
                const points = 52;
                const raw = kws.map((k) => Array.from({ length: points }, (_, i) => level(k) * (1 + ((hash(k) >> (i % 16)) % 5) / 10)));
                const max = Math.max(1, ...raw.flat());
                return xssi({ default: { timelineData: Array.from({ length: points }, (_, i) => ({ time: String(1761436800 + i * 604800), formattedTime: 'x', value: raw.map((r) => Math.round((r[i] / max) * 100)), hasData: raw.map((r) => r[i] > 0), ...(i === points - 1 ? { isPartial: true } : {}) })), averages: [] } });
            }
            if (p.endsWith('/comparedgeo')) {
                const regions = w.resolution === 'DMA' ? [['501', 'New York NY'], ['803', 'Los Angeles CA']] : w.resolution === 'COUNTRY' ? [['US', 'United States'], ['IN', 'India'], ['GB', 'United Kingdom']] : [['US-CA', 'California'], ['US-NY', 'New York'], ['US-WY', 'Wyoming']];
                return xssi({ default: { geoMapData: regions.map(([c, n], i) => ({ geoCode: c, geoName: n, value: [i === 2 ? 0 : 100 - i * 20], hasData: [i !== 2] })) } });
            }
            if (token === 'TOP') {
                if (!viaResidential) return xssi({ default: { rankedList: [] } });
                hits.residentialTopics += 1;
                return xssi({ default: { rankedList: [{ rankedKeyword: [{ topic: { mid: '/m/0663v', title: 'Pizza', type: 'Dish' }, value: 100, formattedValue: '100', link: '/trends/explore?q=/m/0663v' }] }, { rankedKeyword: [{ topic: { mid: '/m/x', title: 'Pizza oven', type: 'Topic' }, value: 5100, formattedValue: 'Breakout', link: '/trends/explore?q=/m/x' }] }] } });
            }
            if (token === 'QRY') return xssi({ default: { rankedList: [{ rankedKeyword: Array.from({ length: 30 }, (_, i) => ({ query: `${w.kw} q${i}`, value: 100 - i, formattedValue: String(100 - i), link: `/trends/explore?q=${encodeURIComponent(w.kw)}+q${i}` })) }, { rankedKeyword: [{ query: `${w.kw} new`, value: 5100, formattedValue: 'Breakout', link: '/trends/explore?q=x' }, { query: `${w.kw} rising`, value: 250, formattedValue: '+250%', link: '/trends/explore?q=y' }] }] } });
        }
        if (p === '/trending/rss') {
            const geo = url.searchParams.get('geo');
            const items = Array.from({ length: 4 }, (_, i) => `<item><title>${geo} trend ${i} &amp; more</title><ht:approx_traffic>${(i + 1) * 1000}+</ht:approx_traffic><pubDate>Wed, 28 Oct 2026 05:00:00 -0700</pubDate><ht:picture>https://img/${i}.jpg</ht:picture><ht:picture_source>Src</ht:picture_source><ht:news_item><ht:news_item_title>News ${i}</ht:news_item_title><ht:news_item_url>https://news/${i}</ht:news_item_url><ht:news_item_source>Paper</ht:news_item_source><ht:news_item_picture>https://n/${i}.jpg</ht:news_item_picture></ht:news_item></item>`).join('');
            return send(200, `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`, 'application/rss+xml');
        }
        send(404, 'not found', 'text/plain');
    };
    const server = http.createServer((req, res) => handle(req, res, false));
    const resi = http.createServer((req, res) => handle(req, res, true)); // HTTP proxy: req.url is absolute
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    await new Promise((r) => resi.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${server.address().port}`, residentialProxyUrl: `http://127.0.0.1:${resi.address().port}`, hits, close: () => { server.close(); resi.close(); } };
}
