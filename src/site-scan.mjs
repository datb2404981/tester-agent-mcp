import { chromium } from 'playwright';
import { isHttpTarget, isPageInScope } from './scope.mjs';

// A reusable read-only observation pass for a registered local/QA website.
export const scanSite = async ({ url, baseUrl = url, maxPages = 5, mobile = true, allowedOrigins = [] }) => {
  const browser = await chromium.launch({ headless: true, timeout: 20000 });
  const scanned = [];
  const issues = [];
  const blockedRequests = new Map();
  const queue = [url];
  const visited = new Set();
  const scope = new URL(baseUrl);
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1366, height: 768 };

  try {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    const origins = new Set([scope.origin, ...allowedOrigins]);
    const inScope = (target) => isPageInScope(target, scope);
    const allowedRequest = (target, isNavigation) => isHttpTarget(target) &&
      origins.has(target.origin) && (!isNavigation || inScope(target));
    const recordBlocked = (address, method, reason) => {
      const target = new URL(address);
      const entry = { origin: target.origin, path: target.pathname.slice(0, 160), method, reason };
      const key = JSON.stringify(entry);
      blockedRequests.set(key, { ...entry, count: (blockedRequests.get(key)?.count ?? 0) + 1 });
    };
    await context.routeWebSocket('**/*', (socket) => {
      recordBlocked(socket.url(), 'WEBSOCKET', 'read_only');
      socket.close({ code: 1008, reason: 'QA read-only scan' });
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const navigation = request.isNavigationRequest();
      if (!['GET', 'HEAD'].includes(request.method())) {
        recordBlocked(request.url(), request.method(), 'read_only');
        return route.abort('blockedbyclient');
      }
      if (!allowedRequest(new URL(request.url()), navigation)) {
        recordBlocked(request.url(), request.method(), 'outside_scope');
        return route.abort('blockedbyclient');
      }
      try {
        // A browser redirect chain can bypass subsequent route callbacks.
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if ([301, 302, 303, 307, 308].includes(response.status()) && response.headers().location) {
          recordBlocked(request.url(), request.method(), 'http_redirect');
          return route.abort('blockedbyclient');
        }
        return route.fulfill({ response });
      } catch {
        return route.abort('failed').catch(() => {});
      }
    });
    context.on('page', (newPage) => {
      if (newPage !== page) void newPage.close().catch(() => {});
    });
    page.on('pageerror', (error) => {
      issues.push({ kind: 'javascript', page: page.url(), detail: error.message.slice(0, 300) });
    });
    page.on('console', (message) => {
      // Chromium reports our own policy blocks as console errors. Vite's HMR
      // WebSocket also fails intentionally in a read-only observation pass.
      if (message.type() === 'error' &&
          !/ERR_BLOCKED_BY_CLIENT|^\[vite\] failed to connect to websocket/i.test(message.text())) {
        issues.push({ kind: 'console', page: page.url(), detail: message.text().slice(0, 300) });
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        issues.push({ kind: 'http_5xx', page: page.url(), status: response.status(), url: response.url() });
      }
    });

    while (queue.length && scanned.length < maxPages) {
      const next = queue.shift();
      if (visited.has(next)) continue;
      visited.add(next);
      try {
        const response = await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(300);
        const observed = await page.evaluate(() => ({
          title: document.title,
          headings: [...document.querySelectorAll('h1, h2')].slice(0, 8).map((el) => el.textContent?.trim()),
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
          links: [...document.querySelectorAll('a[href]')].map((el) => el.href)
        }));
        const current = page.url();
        scanned.push({ url: current, status: response?.status() ?? null,
          title: observed.title, headings: observed.headings, horizontalOverflow: observed.horizontalOverflow });
        if (response && response.status() >= 400) {
          issues.push({ kind: 'navigation_http', page: current, status: response.status() });
        }
        if (observed.horizontalOverflow) {
          issues.push({ kind: 'horizontal_overflow', page: current, viewportWidth: viewport.width });
        }
        for (const href of observed.links) {
          try {
            const target = new URL(href);
            if (/(?:^|[\/#_-])(logout|signout|delete|remove|destroy|reset|unsubscribe)(?:$|[\/#?_-])/i.test(target.pathname + target.hash)) {
              continue;
            }
            if (inScope(target) && !target.search &&
                !visited.has(target.href) &&
                !queue.includes(target.href) && queue.length < maxPages * 3) {
              queue.push(target.href);
            }
          } catch { /* Invalid link. */ }
        }
      } catch (error) {
        if (!/ERR_BLOCKED_BY_CLIENT/.test(error.message)) {
          issues.push({ kind: 'navigation_error', page: next, detail: error.message.slice(0, 300) });
        }
      }
    }
    const blocked = [...blockedRequests.values()];
    const outcome = scanned.length === 0 ? 'BLOCKED' : issues.length ? 'FAIL'
      : blocked.length ? 'REVIEW_REQUIRED' : 'PASS';
    return { ok: outcome === 'PASS', outcome,
      pages: scanned, issues, blockedRequests: blocked, viewport, exploredCount: scanned.length };
  } finally {
    await browser.close();
  }
};
