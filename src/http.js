// HTTP client: network routes with automatic fallback, per-session cookies (NID), Google block detection, rate limiting, retries.
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import { log } from 'apify';

const BACKOFF = Number(process.env.HTTP_BACKOFF_SCALE ?? 1); // tests shorten retry pauses
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * BACKOFF)));

export class BlockedError extends Error {}
/** Run-wide settings (set from the input). */
export const httpConfig = { timeoutMs: 30000 };
export class StoppedError extends Error {}

class RateLimiter {
    constructor(perMinute) {
        this.interval = 60000 / perMinute;
        this.next = 0;
    }

    /** Waits for the next request slot; gives up as soon as the run starts stopping. */
    async wait(msLeft) {
        const slot = Math.max(Date.now(), this.next);
        this.next = slot + this.interval;
        while (Date.now() < slot) {
            if (msLeft() <= 0) throw new StoppedError('run stopping');
            await sleep(Math.min(500, slot - Date.now()));
        }
    }
}

/** One identity: proxy session (= IP) and its cookies. */
export class Session {
    constructor() {
        this.rotate();
    }

    rotate() {
        this.id = `s${Math.random().toString(36).slice(2, 12)}`;
        this.jar = new CookieJar();
    }
}

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const JSON_HEADERS = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'application/json, text/plain, */*', referer: 'https://trends.google.com/trends/explore' };
export const HTML_HEADERS = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
export const RSS_HEADERS = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' };

/** Why Google refused a response, or null. */
export function blockReason(res) {
    const body = typeof res.body === 'string' ? res.body.slice(0, 3000) : '';
    if (res.statusCode === 429) return 'HTTP 429 (Google Trends rate limit for this IP)';
    if (/\/sorry\/|unusual traffic|detected unusual|captcha/i.test(`${res.url ?? ''} ${body}`)) return 'hard: Google asked for a captcha (IP flagged)';
    if (res.statusCode === 403) return 'HTTP 403 (refused)';
    return null;
}

export class Client {
    /** @param routes ordered [{label, proxy}] — proxy undefined = the server's own IP */
    constructor({ routes, msLeft, stats }) {
        const scale = Number(process.env.HTTP_RATE_SCALE ?? 1) || 1;
        // Google Trends is strict: 150/min through a proxy (new IP per session), 40/min from the server IP.
        this.routes = routes.map((r) => ({ ...r, ok: 0, fail: 0, streak: 0, limiter: new RateLimiter((r.proxy ? 150 : 40) * scale) }));
        this.routeIdx = 0;
        this.msLeft = msLeft;
        this.stats = stats;
    }

    get route() {
        return this.routes[this.routeIdx];
    }

    routeResult(idx, ok, hard = false) {
        const r = this.routes[idx];
        if (ok) {
            r.ok += 1;
            r.streak = 0;
            return;
        }
        r.fail += 1;
        r.streak += 1;
        if (hard) r.hard = (r.hard ?? 0) + 1;
        // A captcha page means the IP range is flagged: 3 of them with no success = move on at once.
        const dead = (r.ok === 0 && ((r.hard ?? 0) >= 3 || r.fail >= 6)) || r.streak >= 15;
        if (dead && idx === this.routeIdx && this.routeIdx < this.routes.length - 1) {
            this.routeIdx += 1;
            this.stats.routeSwitches = (this.stats.routeSwitches ?? 0) + 1;
            log.warning(`Google keeps refusing "${r.label}" (${r.ok} ok / ${r.fail} blocked). Switching to "${this.route.label}".`);
        }
    }

    routesSummary() {
        return this.routes.map((r, i) => ({ route: r.label, used: i <= this.routeIdx, ok: r.ok, blocked: r.fail, active: i === this.routeIdx }));
    }

    /**
     * One request. On a block the session rotates (new IP + fresh cookies) and `onRotate` can rebuild what the next
     * attempt needs (e.g. reload the page for new tokens). The route switches when it keeps failing.
     * @returns {Promise<{status:number, body:any, headers:object, url:string}>}
     */
    async fetch(o, session) {
        const attempts = o.attempts ?? (this.route.proxy ? 8 : 3);
        let last = 'unknown';
        let restarts = 0;
        for (let a = 0; a < attempts; a++) {
            if (this.msLeft() <= 0) throw new StoppedError('run stopping');
            const extra = o.prepare ? await o.prepare(session) : {};
            const idx = this.routeIdx;
            const route = this.routes[idx];
            await route.limiter.wait(this.msLeft);
            this.stats.requests += 1;
            let res;
            try {
                res = await gotScraping({
                    url: extra.url ?? o.url,
                    method: o.method ?? 'GET',
                    ...(extra.body ?? o.body ? { body: extra.body ?? o.body } : {}),
                    headers: { ...(o.headers ?? JSON_HEADERS), ...(extra.headers ?? {}) },
                    cookieJar: session.jar,
                    useHeaderGenerator: false,
                    proxyUrl: route.proxy ? await route.proxy.newUrl(session.id) : undefined,
                    responseType: o.responseType ?? 'text',
                    followRedirect: true,
                    throwHttpErrors: false,
                    retry: { limit: 0 },
                    timeout: { request: o.timeoutMs ?? httpConfig.timeoutMs },
                });
            } catch (err) {
                this.stats.networkErrors += 1;
                last = `network error ${err.code || err.message}`;
                this.routeResult(idx, false);
                session.rotate();
                await sleep(route.proxy ? 500 : 2000 * 2 ** a);
                continue;
            }
            log.debug(`${o.method ?? 'GET'} ${extra.url ?? o.url} -> ${res.statusCode} via ${route.label}`);
            const reason = blockReason(res) ?? o.isBlocked?.(res) ?? null;
            if (reason) {
                this.stats.blocked += 1;
                last = reason.replace(/^hard: /, '');
                this.routeResult(idx, false, reason.startsWith('hard: '));
                session.rotate();
                if (this.routeIdx !== idx && restarts < this.routes.length) { // route changed: fresh budget on the new route
                    restarts += 1;
                    a = -1;
                    continue;
                }
                await sleep(route.proxy ? 300 + Math.random() * 400 : Math.min(20000, 2500 * 2 ** a));
                continue;
            }
            if (res.statusCode >= 500) {
                last = `HTTP ${res.statusCode}`;
                await sleep(1500);
                continue;
            }
            this.routeResult(idx, true);
            return { status: res.statusCode, body: res.body, headers: res.headers, url: res.url };
        }
        throw new BlockedError(last);
    }
}
