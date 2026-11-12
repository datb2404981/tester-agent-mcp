import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { getProject, resolvePageUrl, stateRoot } from './generic.mjs';
import { isHttpTarget, isPageInScope } from './scope.mjs';
import { buildAgentBugReport, sanitizeBugReport, writeBugArtifacts } from './bug-report.mjs';

// Browser sessions stay inside the MCP server. The connected AI chooses each action
// from the live accessibility tree, rather than requiring project-specific scripts.
const sessions = new Map();
const opening = new Set();
const sessionIdleMs = 12 * 60 * 1000;

const safeUrl = (address) => {
  try {
    const parsed = new URL(address);
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    // OAuth tokens and one-time credentials may live entirely in a URL fragment.
    parsed.hash = '';
    return parsed.href;
  } catch { return '[URL không hợp lệ]'; }
};

// Browser inputs are kept in memory just long enough to mask sensitive evidence.
const redact = (session, value) => {
  let result = String(value ?? '');
  for (const secret of session.secrets) {
    if (secret.length >= 4) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]*/gi, '$1#[REDACTED_FRAGMENT]')
    .replace(/([?&](?:token|secret|password|session|key|code|auth)=)[^&#\s]+/gi, '$1[REDACTED]');
};

const sanitized = (session, value) => JSON.parse(JSON.stringify(value, (key, item) => {
  if (typeof item !== 'string') return item;
  return redact(session, ['url', 'page'].includes(key) && /^https?:\/\//.test(item)
    ? safeUrl(item) : item);
}));

const sessionFor = (project) => {
  const session = sessions.get(project);
  if (!session) throw new Error(`Chưa mở phiên browser cho ${project}. Dùng tester_browser_start.`);
  return session;
};

const inspect = async (session) => ({
  project: session.project,
  url: safeUrl(session.page.url()),
  title: redact(session, await session.page.title()),
  viewport: session.page.viewportSize(),
  accessibility: redact(session, (await session.page.locator('body').ariaSnapshot()).slice(0, 12000)),
  errors: session.errors.slice(-10).map((error) => redact(session, error)),
  blockedRequests: sanitized(session, session.blockedRequests.slice(-10)),
  responses: sanitized(session, session.responses.slice(-15).map(({ method, path, status }) =>
    ({ method, path, status })))
});

// A single tab must not receive overlapping clicks, screenshots and assertions.
const armIdleTimer = (session) => {
  session.expiry = setTimeout(() => {
    if (sessions.get(session.project) !== session) return;
    sessions.delete(session.project);
    void session.browser.close().catch(() => {});
  }, sessionIdleMs).unref();
};

const useSession = async (project, operation) => {
  const session = sessionFor(project);
  if (session.busy) throw new Error(`Phiên ${project} đang thực hiện một thao tác khác.`);
  session.busy = true;
  clearTimeout(session.expiry);
  try { return await operation(session); }
  finally {
    session.busy = false;
    if (sessions.get(project) === session) armIdleTimer(session);
  }
};

const screenshot = (session) => session.page.screenshot({
  type: 'jpeg', quality: 78, animations: 'disabled', timeout: 15000,
  mask: [
    session.page.locator('input, textarea, [contenteditable="true"]'),
    ...[...session.secrets].filter((value) => value.length >= 4)
      .map((value) => session.page.getByText(value, { exact: false }))
  ]
});

// The image is returned as MCP image content to the connected vision model.
// It is never embedded in a text JSON response or stored on every inspection.
export const seeBrowser = async ({ project }) => useSession(project, async (session) => ({
  observation: await inspect(session),
  image: (await screenshot(session)).toString('base64')
}));

const locatorFor = (page, { selector = '', role = '', name = '' }) => {
  if (selector) return page.locator(selector);
  if (role) return page.getByRole(role, name ? { name, exact: true } : {});
  throw new Error('Cần selector CSS hoặc role để xác định phần tử.');
};

// Permit only identifiable navigation and disclosure controls during read-only
// exploration. Network enforcement below still blocks non-GET requests and
// out-of-scope origins; no DOM heuristic can establish that a GET is side-effect free.
const readOnlyClickAllowed = async (session, element) => {
  const target = await element.evaluate((node) => {
    const control = node.closest('a, button, summary, [role="tab"], [aria-haspopup], [aria-expanded]');
    if (!control) return { kind: 'unknown' };
    if (control.matches('a')) {
      return { kind: 'link', href: control.href, download: control.hasAttribute('download'),
        target: control.getAttribute('target') };
    }
    if (control.matches('summary') && control.parentElement?.matches('details')) {
      return { kind: 'disclosure' };
    }
    if (control.matches('[role="tab"], [aria-haspopup], [aria-expanded]') &&
        (!control.matches('button') || control.type === 'button')) {
      return { kind: 'disclosure' };
    }
    return { kind: 'unknown' };
  });
  if (target.kind === 'disclosure') return true;
  if (target.kind !== 'link' || target.download ||
      (target.target && target.target !== '_self')) return false;
  return isPageInScope(new URL(target.href), new URL(session.config.baseUrl));
};

export const startBrowser = async ({ project, page = '', goal = '', viewport = 'desktop' }) => {
  const config = await getProject(project);
  if (sessions.has(project) || opening.has(project)) {
    throw new Error(`Phiên browser ${project} đang mở. Hoàn tất phiên trước.`);
  }
  if (sessions.size + opening.size >= 4) throw new Error('Đã đạt giới hạn 4 phiên browser.');
  if (!['desktop', 'mobile'].includes(viewport) || typeof goal !== 'string' || goal.length > 240) {
    throw new Error('Viewport hoặc mục tiêu kiểm thử không hợp lệ.');
  }
  const entryUrl = resolvePageUrl(config, page);
  opening.add(project);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: viewport === 'mobile'
      ? { width: 390, height: 844 } : { width: 1366, height: 768 } });
    const origin = new URL(config.baseUrl);
    // Chromium requires explicit Local Network Access permission for loopback
    // WebSockets. Limit the grant to the registered local QA origin.
    if (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
      await context.grantPermissions(['local-network-access'], { origin: origin.origin });
    }
    const tab = await context.newPage();
    const session = { project, config, browser, context, page: tab,
      goal, viewport, startedAt: new Date().toISOString(), actions: [],
      assertions: [], visualFindings: [], securityAudits: [], layoutAudits: [],
      accessibilityAudits: [],
      cases: [], activeCase: null, responses: [], responseSequence: 0,
      blockedRequests: [], blockedSequence: 0,
      navigationHeaders: {}, errors: [], secrets: new Set(), busy: false };
    const recordBlocked = (method, url, reason) => {
      session.blockedRequests.push({ sequence: ++session.blockedSequence,
        method, path: new URL(url).pathname, reason });
      if (session.blockedRequests.length > 60) session.blockedRequests.shift();
    };
    const allowedOrigins = new Set([origin.origin, ...config.allowedOrigins]);
    // WebSockets do not go through context.route(). A read-only run must not
    // open a state-changing socket, including to otherwise permitted origins.
    await context.routeWebSocket('**/*', (socket) => {
      const target = new URL(socket.url());
      const protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
      const socketOrigin = `${protocol}//${target.host}`;
      if (!config.allowWrites || !allowedOrigins.has(socketOrigin)) {
        recordBlocked('WEBSOCKET', socket.url(), !config.allowWrites ? 'read_only' : 'outside_scope');
        socket.close({ code: 1008, reason: 'QA scope' });
        return;
      }
      socket.connectToServer();
    });
    // Enforce scope on every network request, including fetch, iframes and redirects.
    // Cross-origin APIs/CDNs must be explicitly registered as allowedOrigins.
    await context.route('**/*', async (route) => {
      const request = route.request();
      const destination = new URL(request.url());
      // Treat document navigation in popups and iframes as in-scope pages too.
      const inScope = (target) => isHttpTarget(target) && allowedOrigins.has(target.origin) &&
        (!request.isNavigationRequest() || isPageInScope(target, origin));
      const readOnly = !config.allowWrites && !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      if (readOnly || !inScope(destination)) {
        recordBlocked(request.method(), request.url(), readOnly ? 'read_only' : 'outside_scope');
        return route.abort('blockedbyclient');
      }
      try {
        // Playwright may only route the first URL in a redirect chain.
        // Stop at Location so later hops cannot leave the registered scope.
        const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if ([301, 302, 303, 307, 308].includes(response.status()) && response.headers().location) {
          recordBlocked(request.method(), request.url(), 'http_redirect');
          return route.abort('blockedbyclient');
        }
        return route.fulfill({ response });
      } catch {
        return route.abort('failed').catch(() => {});
      }
    });
    context.on('page', (newTab) => { if (newTab !== tab) newTab.close().catch(() => {}); });
    tab.on('pageerror', (error) => session.errors.push(error.message.slice(0, 400)));
    tab.on('response', (response) => {
      try {
        const request = response.request();
        session.responses.push({ sequence: ++session.responseSequence,
          method: request.method(), path: new URL(response.url()).pathname,
          status: response.status() });
        if (session.responses.length > 60) session.responses.shift();
        if (request.isNavigationRequest() && request.frame() === tab.mainFrame()) {
          session.navigationHeaders = response.headers();
        }
      } catch { /* A detached navigation has no usable frame. */ }
    });
    await tab.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const observation = await inspect(session);
    sessions.set(project, session);
    armIdleTimer(session);
    return observation;
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  } finally {
    opening.delete(project);
  }
};

export const inspectBrowser = async ({ project }) => useSession(project, inspect);

export const resizeBrowser = async ({ project, viewport }) => useSession(project, async (session) => {
  if (!['desktop', 'mobile'].includes(viewport)) throw new Error('Viewport không hợp lệ.');
  await session.page.setViewportSize(viewport === 'mobile'
    ? { width: 390, height: 844 } : { width: 1366, height: 768 });
  session.viewport = viewport;
  return inspect(session);
});

// A flow declares its required checkpoints before any actions are performed.
// Each checkpoint needs a browser assertion captured while that step is active.
export const caseBrowser = async ({ project, phase, name = '', expected = '',
  category = 'functional', kind = 'check', steps = [] }) => useSession(project, async (session) => {
  if (phase === 'start') {
    if (session.activeCase) throw new Error('Cần kết thúc test case đang chạy trước.');
    if (!name.trim() || !expected.trim() ||
        !['functional', 'security', 'visual'].includes(category)) {
      throw new Error('Test case phải có tên, kết quả mong đợi và nhóm hợp lệ.');
    }
    if (!['check', 'flow'].includes(kind) || !Array.isArray(steps) ||
        (kind === 'flow' && (steps.length < 2 || steps.length > 12)) ||
        (kind === 'check' && steps.length !== 0) ||
        steps.some((step) => !/^[a-zA-Z][\w-]{0,39}$/.test(step?.id || '') ||
          !step?.description?.trim() || !step?.expected?.trim()) ||
        new Set(steps.map((step) => step.id)).size !== steps.length) {
      throw new Error('Luồng E2E cần 2–12 bước có id duy nhất, mô tả và kết quả mong đợi.');
    }
    session.activeCase = {
      name, expected, category, kind, steps: steps.map((step) => ({ ...step, state: 'NOT_STARTED' })),
      activeStep: null, startedAt: new Date().toISOString(),
      actionStart: session.actions.length, assertionStart: session.assertions.length,
      errorStart: session.errors.length, visualStart: session.visualFindings.length,
      auditStart: session.securityAudits.length, layoutStart: session.layoutAudits.length,
      accessibilityStart: session.accessibilityAudits.length,
      responseStart: session.responseSequence,
      blockedStart: session.blockedSequence
    };
    return sanitized(session, { project, name, category, kind,
      requiredSteps: steps.map(({ id, description, expected: stepExpected }) =>
        ({ id, description, expected: stepExpected })), state: 'RUNNING' });
  }
  if (phase !== 'finish' || !session.activeCase) {
    throw new Error('Cần bắt đầu test case trước khi kết thúc.');
  }
  const current = session.activeCase;
  const actions = session.actions.slice(current.actionStart);
  const assertions = session.assertions.slice(current.assertionStart);
  const failed = assertions.some((assertion) => assertion.outcome === 'FAIL') ||
    session.errors.length > current.errorStart ||
    current.steps.some((step) => step.outcome === 'FAIL');
  const actionBlocked = actions.some((step) => !step.success) ||
    current.steps.some((step) => step.outcome === 'BLOCKED');
  const audits = session.securityAudits.slice(current.auditStart);
  // The evidence log retains only the latest 60 entries. Sequence numbers
  // keep case boundaries correct after that buffer reaches its capacity.
  const blockedRequests = session.blockedRequests.filter((item) =>
    item.sequence > current.blockedStart);
  const visualCount = session.visualFindings.length - current.visualStart;
  const review = current.category === 'security'
    ? audits.some((audit) => audit.outcome === 'REVIEW_REQUIRED')
    : current.category === 'visual' && (visualCount > 0 ||
      session.layoutAudits.slice(current.layoutStart)
        .some((audit) => audit.outcome === 'REVIEW_REQUIRED') ||
      session.accessibilityAudits.slice(current.accessibilityStart)
        .some((audit) => audit.outcome === 'REVIEW_REQUIRED'));
  const missingStep = current.steps.some((step) => step.state !== 'FINISHED' ||
    step.outcome !== 'PASS');
  const outcome = failed ? 'FAIL' : actionBlocked || blockedRequests.length || missingStep ? 'BLOCKED'
    : review ? 'REVIEW_REQUIRED' : assertions.length === 0 ? 'BLOCKED' : 'PASS';
  const record = {
    name: current.name, expected: current.expected, category: current.category,
    kind: current.kind, steps: current.steps.map(({ actionStart, assertionStart, errorStart,
      blockedStart, ...step }) => step),
    startedAt: current.startedAt, finishedAt: new Date().toISOString(),
    actionCount: actions.length, assertions, outcome,
    blockedRequests,
    visualFindingCount: visualCount, securityAuditCount: audits.length
  };
  session.cases.push(sanitized(session, record));
  session.activeCase = null;
  return sanitized(session, record);
});

export const stepBrowser = async ({ project, phase, id }) => useSession(project, async (session) => {
  const current = session.activeCase;
  if (!current || current.kind !== 'flow') {
    throw new Error('Cần bắt đầu test case kind=flow với các bước bắt buộc.');
  }
  const step = current.steps.find((item) => item.id === id);
  if (!step) throw new Error('Bước không có trong luồng E2E đã đăng ký.');
  if (phase === 'start') {
    if (current.activeStep || step.state !== 'NOT_STARTED' ||
        current.steps.find((item) => item.state === 'NOT_STARTED') !== step) {
      throw new Error('Các bước E2E phải được kiểm chứng theo thứ tự đã đăng ký.');
    }
    step.state = 'RUNNING';
    step.startedAt = new Date().toISOString();
    step.actionStart = session.actions.length;
    step.assertionStart = session.assertions.length;
    step.errorStart = session.errors.length;
    step.blockedStart = session.blockedSequence;
    step.responseStart = session.responseSequence;
    current.activeStep = id;
    return sanitized(session, { id, description: step.description, expected: step.expected,
      state: step.state });
  }
  if (phase !== 'finish' || current.activeStep !== id || step.state !== 'RUNNING') {
    throw new Error('Cần kết thúc đúng bước E2E đang thực hiện.');
  }
  const actions = session.actions.slice(step.actionStart);
  const assertions = session.assertions.slice(step.assertionStart);
  step.actionCount = actions.length;
  step.assertions = assertions;
  step.outcome = assertions.some((assertion) => assertion.outcome === 'FAIL') ||
    session.errors.length > step.errorStart ? 'FAIL'
    : actions.some((action) => !action.success) ||
      session.blockedRequests.some((request) => request.sequence > step.blockedStart) ||
      assertions.length === 0 ? 'BLOCKED' : 'PASS';
  step.state = 'FINISHED';
  step.finishedAt = new Date().toISOString();
  current.activeStep = null;
  const { actionStart, assertionStart, errorStart, blockedStart, responseStart, ...record } = step;
  return sanitized(session, record);
});

// Inspect measurable layout conditions. The vision model still decides whether
// a visual issue is a real defect or a design improvement.
export const auditBrowserLayout = async ({ project }) => useSession(project, async (session) => {
  const metrics = await session.page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    const scrollWidth = Math.max(root.scrollWidth, document.body?.scrollWidth || 0);
    return { viewportWidth: width, scrollWidth,
      horizontalOverflowPx: Math.max(0, scrollWidth - width) };
  });
  const audit = { page: safeUrl(session.page.url()), viewport: session.page.viewportSize(),
    observedAt: new Date().toISOString(), metrics,
    outcome: metrics.horizontalOverflowPx > 1 ? 'REVIEW_REQUIRED' : 'OBSERVED' };
  session.layoutAudits.push(audit);
  return sanitized(session, audit);
});

// Bounded DOM checks surface concrete issues for model review. They do not
// establish full WCAG compliance or substitute for keyboard/vision checks.
export const auditBrowserAccessibility = async ({ project }) => useSession(project, async (session) => {
  const issues = await session.page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[aria-hidden="true"], [inert]');
    const hasName = (element) => Boolean(element.getAttribute('aria-label')?.trim() ||
      element.getAttribute('aria-labelledby')?.trim() ||
      element.getAttribute('title')?.trim());
    const findings = [];
    const record = (category, elements) => {
      for (const [index, element] of elements.entries()) {
        if (findings.length >= 40) break;
        findings.push({ category, element: element.tagName.toLowerCase(),
          position: index + 1 });
      }
    };
    record('input_missing_label', [...document.querySelectorAll('input, select, textarea')]
      .filter((element) => visible(element) &&
        !['hidden', 'button', 'submit', 'reset', 'image'].includes(element.type) &&
        !element.labels?.length && !hasName(element)));
    record('button_missing_name', [...document.querySelectorAll('button, [role="button"]')]
      .filter((element) => visible(element) && !hasName(element) &&
        !element.textContent?.trim() && !element.querySelector('img[alt]:not([alt=""])')));
    record('link_missing_name', [...document.querySelectorAll('a[href]')]
      .filter((element) => visible(element) && !hasName(element) &&
        !element.textContent?.trim() && !element.querySelector('img[alt]:not([alt=""])')));
    record('image_missing_alt', [...document.querySelectorAll('img:not([alt])')]
      .filter(visible));
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
    const skipped = headings.filter((element, index) => index > 0 &&
      Number(element.tagName[1]) - Number(headings[index - 1].tagName[1]) > 1);
    record('heading_level_skipped', skipped);
    return findings;
  });
  const audit = { page: safeUrl(session.page.url()), viewport: session.page.viewportSize(),
    observedAt: new Date().toISOString(), issues,
    outcome: issues.length ? 'REVIEW_REQUIRED' : 'OBSERVED',
    scope: 'DOM labels, names, image alt attributes and heading levels only' };
  session.accessibilityAudits.push(audit);
  return sanitized(session, audit);
});

// Passive, bounded security signals from the page already visited. No payloads,
// enumeration, crawling or extra HTTP requests are issued by this audit.
export const auditBrowserSecurity = async ({ project }) => useSession(project, async (session) => {
  const pageUrl = new URL(session.page.url());
  const headers = session.navigationHeaders;
  const forms = await session.page.evaluate(() => [...document.forms].map((form) => ({
    hasPassword: Boolean(form.querySelector('input[type="password"]')),
    externalAction: new URL(form.action || document.URL, document.URL).origin !== location.origin
  })));
  const cookies = await session.context.cookies();
  const sessionCookies = cookies.filter((cookie) => /(?:session|auth|token|sid|jwt)/i.test(cookie.name));
  const warnings = [];
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(pageUrl.hostname);
  if (pageUrl.protocol !== 'https:' && !local) {
    warnings.push({ category: 'transport', detail: 'Trang QA từ xa đang sử dụng HTTP.' });
  }
  if (pageUrl.protocol === 'https:' && !headers['strict-transport-security']) {
    warnings.push({ category: 'headers', detail: 'Chưa quan sát thấy HSTS trên phản hồi trang.' });
  }
  if (!headers['content-security-policy']) {
    warnings.push({ category: 'headers', detail: 'Chưa quan sát thấy Content-Security-Policy trên phản hồi trang.' });
  }
  if (!headers['x-frame-options'] && !/frame-ancestors/i.test(headers['content-security-policy'] || '')) {
    warnings.push({ category: 'headers', detail: 'Chưa quan sát thấy chính sách giới hạn nhúng frame.' });
  }
  if (forms.some((form) => form.hasPassword && form.externalAction)) {
    warnings.push({ category: 'forms', detail: 'Biểu mẫu mật khẩu có đích gửi khác origin, cần kiểm tra thiết kế.' });
  }
  if (sessionCookies.some((cookie) => !cookie.httpOnly)) {
    warnings.push({ category: 'cookies', detail: 'Có cookie mang tên liên quan phiên đăng nhập thiếu HttpOnly.' });
  }
  if (pageUrl.protocol === 'https:' && sessionCookies.some((cookie) => !cookie.secure)) {
    warnings.push({ category: 'cookies', detail: 'Có cookie liên quan phiên đăng nhập thiếu Secure.' });
  }
  const audit = {
    page: safeUrl(session.page.url()), viewport: session.page.viewportSize(),
    observedAt: new Date().toISOString(),
    signals: {
      https: pageUrl.protocol === 'https:',
      hasCsp: Boolean(headers['content-security-policy']),
      hasFrameProtection: Boolean(headers['x-frame-options'] ||
        /frame-ancestors/i.test(headers['content-security-policy'] || '')),
      passwordFormCount: forms.filter((form) => form.hasPassword).length,
      sessionCookieCount: sessionCookies.length
    },
    warnings,
    outcome: warnings.length ? 'REVIEW_REQUIRED' : 'OBSERVED'
  };
  session.securityAudits.push(audit);
  return sanitized(session, audit);
});

export const actBrowser = async ({ project, action, selector = '', role = '', name = '',
  value = '', page = '', x, y, deltaY = 0 }) => useSession(project, async (session) => {
  if (!['navigate', 'click', 'clickAt', 'fill', 'press', 'hover', 'scroll'].includes(action)) {
    throw new Error('Hành động browser không hợp lệ.');
  }
  if (!['navigate', 'scroll', 'hover', 'click'].includes(action) && !session.config.allowWrites) {
    throw new Error('Tương tác có thể thay đổi dữ liệu. Đăng ký dự án QA với allowWrites=true.');
  }
  if (action === 'clickAt') {
    const size = session.page.viewportSize();
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
        x >= size.width || y >= size.height) {
      throw new Error('Tọa độ click phải nằm trong ảnh viewport hiện tại.');
    }
  }
  if (action === 'scroll' && (!Number.isInteger(deltaY) || Math.abs(deltaY) > 3000)) {
    throw new Error('Khoảng cuộn phải là số nguyên từ -3000 đến 3000.');
  }
  if (action === 'click' && !session.config.allowWrites &&
      !await readOnlyClickAllowed(session, locatorFor(session.page, { selector, role, name }))) {
    throw new Error('Chế độ chỉ đọc chỉ cho click liên kết nội bộ, tab hoặc menu hiển thị. Cần allowWrites=true để thao tác khác trên QA.');
  }
  const step = { action, selector, role, name,
    ...(action === 'navigate' ? { page: safeUrl(resolvePageUrl(session.config, page)) } : {}),
    ...(action === 'clickAt' ? { x, y } : {}),
    ...(action === 'scroll' ? { deltaY } : {}) };
  try {
    if (action === 'fill' && value.length >= 4) session.secrets.add(value);
    if (action === 'navigate') {
      await session.page.goto(resolvePageUrl(session.config, page),
        { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else if (action === 'clickAt') {
      await session.page.mouse.click(x, y);
    } else if (action === 'scroll') {
      await session.page.mouse.wheel(0, deltaY);
    } else {
      const element = locatorFor(session.page, { selector, role, name });
      if (action === 'click') await element.click({ timeout: 10000 });
      if (action === 'fill') await element.fill(value, { timeout: 10000 });
      if (action === 'press') await element.press(value, { timeout: 10000 });
      if (action === 'hover') await element.hover({ timeout: 10000 });
    }
    session.actions.push(sanitized(session, { ...step, success: true }));
    return inspect(session);
  } catch (error) {
    session.actions.push(sanitized(session, { ...step, success: false, error: error.message.slice(0, 500) }));
    throw new Error(redact(session, error.message));
  }
});

export const assertBrowser = async ({ project, type, selector = '', role = '', name = '',
  expected = '', method = 'GET', path = '' }) => useSession(project, async (session) => {
  if (!['visible', 'hidden', 'containsText', 'url', 'responseStatus', 'noHorizontalOverflow'].includes(type)) {
    throw new Error('Loại assertion không hợp lệ.');
  }
  if (['containsText', 'url', 'responseStatus'].includes(type) && !expected) {
    throw new Error('Assertion này cần expected.');
  }
  if (type === 'responseStatus' && (!/^\/[\w./{}%-]*$/.test(path) ||
      !/^[A-Z]+$/.test(method) || !/^[1-5]\d\d$/.test(expected))) {
    throw new Error('responseStatus cần path tuyệt đối, method viết hoa và expected là mã HTTP 100–599.');
  }
  if (type === 'responseStatus' && !session.activeCase) {
    throw new Error('responseStatus cần test case đang chạy để tránh dùng phản hồi của luồng trước.');
  }
  if (session.activeCase?.kind === 'flow' && !session.activeCase.activeStep) {
    throw new Error('Luồng E2E cần bắt đầu bước trước khi kiểm chứng assertion.');
  }
  let passed;
  let actual;
  try {
    if (type === 'responseStatus') {
      const activeStep = session.activeCase.kind === 'flow'
        ? session.activeCase.steps.find((item) => item.id === session.activeCase.activeStep)
        : null;
      const responseStart = activeStep?.responseStart ?? session.activeCase.responseStart;
      const matching = () => [...session.responses].reverse().find((item) =>
        item.path === path && item.method === method &&
        item.sequence > responseStart);
      let response = matching();
      if (!response) {
        await session.page.waitForResponse((item) =>
          new URL(item.url()).pathname === path && item.request().method() === method,
        { timeout: 3000 }).catch(() => {});
        response = matching();
      }
      actual = response ? String(response.status) : 'Không quan sát được phản hồi HTTP';
      passed = actual === expected;
    } else if (type === 'noHorizontalOverflow') {
      const metrics = await session.page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth,
          document.body?.scrollWidth || 0)
      }));
      actual = `${Math.max(0, metrics.scrollWidth - metrics.clientWidth)}px overflow`;
      passed = metrics.scrollWidth - metrics.clientWidth <= 1;
    } else if (type === 'url') {
      actual = safeUrl(session.page.url());
      // Compare the actual route, including hash-based SPA routes, without
      // putting fragments or query data into the report.
      passed = session.page.url() === resolvePageUrl(session.config, expected);
    } else {
      const element = type === 'containsText' && !selector && !role
        ? session.page.locator('body') : locatorFor(session.page, { selector, role, name });
      if (type === 'containsText') {
        passed = (await element.innerText({ timeout: 10000 })).includes(expected);
        actual = passed ? `Đã thấy nội dung yêu cầu` : `Không thấy nội dung yêu cầu`;
      } else {
        const visible = await element.isVisible();
        passed = type === 'visible' ? visible : !visible;
        actual = visible ? 'visible' : 'hidden';
      }
    }
  } catch (error) {
    passed = false;
    actual = error.message.slice(0, 400);
  }
  const assertion = { type, selector, role, name,
    ...(type === 'responseStatus' ? { method, path } : {}),
    expected: type === 'url' ? safeUrl(resolvePageUrl(session.config, expected)) : expected,
    actual,
    category: session.activeCase?.category || 'functional', outcome: passed ? 'PASS' : 'FAIL' };
  session.assertions.push(sanitized(session, assertion));
  return sanitized(session, assertion);
});

// The model makes the visual judgment using a live screenshot. Record what it
// actually observed and capture evidence at the moment the finding was made.
export const recordVisualFinding = async ({ project, kind, category, severity,
  description, suggestion = '', observed = '', expected = '', reproductionSteps = [] }) => useSession(project, async (session) => {
  if (!['defect', 'improvement'].includes(kind) ||
      !['layout', 'responsive', 'contrast', 'typography', 'spacing', 'interaction', 'other'].includes(category) ||
      !['low', 'medium', 'high'].includes(severity) || !description?.trim() ||
      !Array.isArray(reproductionSteps) || reproductionSteps.length > 12) {
    throw new Error('Loại, nhóm, mức độ hoặc mô tả lỗi giao diện không hợp lệ.');
  }
  const folder = join(stateRoot, 'projects', project, 'output', 'reports', 'evidence');
  await mkdir(folder, { recursive: true });
  const name = `visual-${randomUUID()}.jpg`;
  await writeFile(join(folder, name), await screenshot(session), { flag: 'wx', mode: 0o600 });
  const finding = {
    kind, category, severity, description: description.slice(0, 500),
    observed: observed.slice(0, 500), expected: expected.slice(0, 500),
    reproductionSteps: reproductionSteps.map((step) => String(step).slice(0, 240)),
    suggestion: suggestion.slice(0, 500), url: safeUrl(session.page.url()),
    viewport: session.page.viewportSize(), evidence: `evidence/${name}`
  };
  session.visualFindings.push(sanitized(session, finding));
  return sanitized(session, finding);
});

export const finishBrowser = async ({ project }) => useSession(project, async (session) => {
  const categoryCases = (category) => session.cases.filter((item) => item.category === category);
  const categoryAssertions = (category) => session.assertions.filter((item) => item.category === category);
  const functionalCases = categoryCases('functional');
  const securityCases = categoryCases('security');
  const visualCases = categoryCases('visual');
  const functionalAssertions = categoryAssertions('functional');
  const securityAssertions = categoryAssertions('security');
  const visualAssertions = categoryAssertions('visual');
  const incomplete = session.activeCase?.category;
  const failed = session.assertions.some((item) => item.outcome !== 'PASS') ||
    session.errors.length > 0 ||
    session.cases.some((item) => item.outcome === 'FAIL');
  const blocked = Boolean(session.activeCase) ||
    session.cases.some((item) => item.outcome === 'BLOCKED') ||
    session.actions.some((item) => !item.success);
  const review = session.blockedRequests.length > 0 || session.visualFindings.length > 0 ||
    session.layoutAudits.some((item) => item.outcome === 'REVIEW_REQUIRED') ||
    session.accessibilityAudits.some((item) => item.outcome === 'REVIEW_REQUIRED') ||
    session.securityAudits.some((item) => item.outcome === 'REVIEW_REQUIRED');
  const report = sanitizeBugReport(sanitized(session, {
    project, mode: 'agent', goal: session.goal, viewport: session.viewport,
    startedAt: session.startedAt, finishedAt: new Date().toISOString(),
    actions: session.actions, assertions: session.assertions,
    visualFindings: session.visualFindings, securityAudits: session.securityAudits,
    layoutAudits: session.layoutAudits, accessibilityAudits: session.accessibilityAudits,
    blockedRequests: session.blockedRequests,
    responses: session.responses.map(({ method, path, status }) => ({ method, path, status })),
    cases: session.cases, incompleteCase: session.activeCase?.name || null,
    errors: session.errors,
    functionalOutcome: functionalCases.some((item) => item.outcome === 'FAIL') ||
        functionalAssertions.some((item) => item.outcome === 'FAIL') ? 'FAIL'
      : incomplete === 'functional' ||
        functionalCases.some((item) => item.outcome === 'BLOCKED') ? 'BLOCKED'
        : functionalCases.length ? 'PASS'
          : functionalAssertions.length ? 'BLOCKED' : 'NOT_TESTED',
    securityOutcome: securityCases.some((item) => item.outcome === 'FAIL') ||
        securityAssertions.some((item) => item.outcome === 'FAIL') ? 'FAIL'
      : incomplete === 'security' ||
        securityCases.some((item) => item.outcome === 'BLOCKED') ? 'BLOCKED'
        : session.securityAudits.some((item) => item.outcome === 'REVIEW_REQUIRED')
          ? 'REVIEW_REQUIRED' : securityCases.length ? 'PASS'
            : securityAssertions.length ? 'BLOCKED'
              : session.securityAudits.length ? 'OBSERVED' : 'NOT_TESTED',
    visualOutcome: visualCases.some((item) => item.outcome === 'FAIL') ||
        visualAssertions.some((item) => item.outcome === 'FAIL') ? 'FAIL'
      : incomplete === 'visual' ||
        visualCases.some((item) => item.outcome === 'BLOCKED') ? 'BLOCKED'
        : session.visualFindings.length ||
          session.accessibilityAudits.some((item) => item.outcome === 'REVIEW_REQUIRED') ||
          session.layoutAudits.some((item) => item.outcome === 'REVIEW_REQUIRED') ? 'REVIEW_REQUIRED'
          : visualCases.length ? 'PASS'
            : visualAssertions.length ? 'BLOCKED'
              : session.layoutAudits.length || session.accessibilityAudits.length
                ? 'OBSERVED' : 'NOT_REVIEWED',
    accessibilityOutcome: session.accessibilityAudits.some((item) =>
      item.outcome === 'REVIEW_REQUIRED') ? 'REVIEW_REQUIRED'
      : session.accessibilityAudits.length ? 'OBSERVED' : 'NOT_REVIEWED',
    outcome: failed ? 'FAIL' : blocked ? 'BLOCKED' : review ? 'REVIEW_REQUIRED'
      : session.cases.length === 0 || session.assertions.length === 0 ? 'BLOCKED' : 'PASS'
  }));
  const folder = join(stateRoot, 'projects', project, 'output', 'reports');
  await mkdir(folder, { recursive: true });
  const name = `agent-${randomUUID()}.json`;
  await writeFile(join(folder, name), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const bugArtifacts = await writeBugArtifacts({
    folder, sourceName: name, report: buildAgentBugReport(report)
  });
  sessions.delete(project);
  await session.browser.close().catch(() => {});
  return { ...report, artifact: { kind: 'reports', name },
    bugArtifacts: { kind: 'reports', ...bugArtifacts } };
});
