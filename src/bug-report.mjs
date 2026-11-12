import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const outcomes = ['FAIL', 'BLOCKED', 'REVIEW_REQUIRED', 'PASS'];
const severities = new Set(['critical', 'high', 'medium', 'low']);
const kinds = new Set(['defect', 'improvement', 'environment_issue', 'test_automation_issue']);

// This filters persisted artifacts too. Keep CSS IDs (e.g. #login-form) intact.
export const sanitizeBugReport = (value, key = '') => {
  if (Array.isArray(value)) return value.map((item) => sanitizeBugReport(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field,
      /^(?:password|passwd|token|accessToken|refreshToken|secret|apiKey|authorization|cookie|set-cookie|credential|clientSecret)$/i.test(field)
        ? '[REDACTED]' : sanitizeBugReport(item, field)]));
  }
  if (typeof value !== 'string') return value;
  let result = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(Basic)\s+[A-Za-z0-9+/=]+/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b((?:password|passwd|token|secret|api[_-]?key|authorization|cookie|sessionid|refresh[_-]?token)\s*[:=]\s*)[^\s&;,]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|password|session|key|code|auth|access_token|refresh_token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]*/gi, '$1#[REDACTED_FRAGMENT]');
  if (key === 'url' || key === 'page') {
    try {
      const url = new URL(result);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        url.search = '';
        url.hash = '';
        url.username = '';
        url.password = '';
        result = url.href;
      }
    } catch { /* A relative path or user-provided label is not a full URL. */ }
  }
  return result;
};

const normalize = (finding) => {
  const steps = Array.isArray(finding.reproductionSteps) ? finding.reproductionSteps : [];
  return {
    type: kinds.has(finding.type) ? finding.type : 'defect',
    severity: severities.has(finding.severity) ? finding.severity : 'medium',
    status: finding.status === 'VERIFIED' && finding.evidence && steps.length > 0 &&
      finding.expected && finding.actual ? 'VERIFIED' : 'REVIEW_REQUIRED',
    category: String(finding.category || 'functional'),
    title: String(finding.title || 'Vấn đề chưa có tiêu đề'),
    expected: String(finding.expected || 'Cần đối chiếu yêu cầu.'),
    actual: String(finding.actual || 'Chưa có bằng chứng để kết luận.'),
    reproductionSteps: steps.map(String).filter(Boolean).slice(0, 20),
    evidence: Array.isArray(finding.evidence) ? finding.evidence.filter(Boolean) :
      finding.evidence ? [finding.evidence] : [],
    testCase: finding.testCase || null,
    checkpoint: finding.checkpoint || null,
    testCases: finding.testCase ? [finding.testCase] : [],
    checkpoints: finding.checkpoint ? [finding.checkpoint] : [],
    location: finding.location || null,
    suggestion: finding.suggestion || null
  };
};

const uniqueValues = (items) => [...new Map(items.map((item) =>
  [JSON.stringify(item), item])).values()];

const hasExecutionEvidence = (original) => original.mode === 'scan'
  ? (original.checks || []).some((check) => (check.pages || []).length > 0)
  : (original.cases || []).some((testCase) => testCase.outcome === 'PASS' &&
    (testCase.assertions?.length > 0 || (testCase.steps || []).some((step) =>
      step.outcome === 'PASS' && step.assertions?.length > 0)));

const assemble = (original, findings) => {
  const unique = new Map();
  for (const item of findings) {
    const finding = normalize(item);
    const key = [finding.type, finding.category, finding.title, finding.location || ''].join('|').toLowerCase();
    if (unique.has(key)) {
      const old = unique.get(key);
      old.evidence = uniqueValues([...old.evidence, ...finding.evidence]);
      old.reproductionSteps = [...new Set([...old.reproductionSteps, ...finding.reproductionSteps])];
      old.testCases = [...new Set([...old.testCases, ...finding.testCases])];
      old.checkpoints = [...new Set([...old.checkpoints, ...finding.checkpoints])];
      if (finding.status === 'VERIFIED') old.status = 'VERIFIED';
    } else unique.set(key, finding);
  }
  const bugs = [...unique.values()].map((item, index) => ({
    id: `BUG-${String(index + 1).padStart(3, '0')}`, ...item
  }));
  const derived = bugs.some((item) => item.type === 'defect' && item.status === 'VERIFIED')
    ? 'FAIL' : bugs.some((item) => item.type === 'environment_issue' ||
        item.type === 'test_automation_issue') ? 'BLOCKED'
      : bugs.length ? 'REVIEW_REQUIRED' : 'PASS';
  const sourceOutcome = outcomes.includes(original.outcome) ? original.outcome : 'BLOCKED';
  const outcome = outcomes.find((item) =>
    item === sourceOutcome || item === derived ||
    (item === 'BLOCKED' && !hasExecutionEvidence(original))) || 'BLOCKED';
  return sanitizeBugReport({
    schemaVersion: 1, project: original.project, mode: original.mode,
    sourceOutcome, outcome, generatedAt: new Date().toISOString(),
    counts: {
      total: bugs.length,
      verified: bugs.filter((item) => item.status === 'VERIFIED').length,
      needsReview: bugs.filter((item) => item.status === 'REVIEW_REQUIRED').length
    },
    bugs
  });
};

const locationOf = (item) => item.url || item.page || null;

export const buildScanBugReport = (original) => {
  const findings = (original.issues || []).map((item) => ({
    type: ['navigation_error'].includes(item.kind) ? 'environment_issue' : 'defect',
    severity: ['http_5xx', 'navigation_error'].includes(item.kind) ? 'high' : 'medium',
    status: ['http_5xx', 'navigation_http', 'javascript', 'console'].includes(item.kind)
      ? 'VERIFIED' : 'REVIEW_REQUIRED', category: item.kind,
    title: `${item.kind} (${item.viewport || 'unknown'})`,
    location: locationOf(item),
    expected: 'Trang hoạt động không có lỗi này trong viewport kiểm tra.',
    actual: item.detail || (item.status ? `HTTP ${item.status}` :
      item.kind === 'horizontal_overflow' ? `Tràn ngang ở ${item.viewportWidth || 'viewport'}px` : item.kind),
    reproductionSteps: [`Mở ${item.page || original.url || 'trang được kiểm tra'}`,
      `Kiểm tra ở viewport ${item.viewport || 'đã ghi nhận'}.`],
    evidence: [{ kind: 'scan', viewport: item.viewport, page: item.page }]
  }));
  for (const item of original.blockedRequests || []) findings.push({
    type: 'environment_issue', severity: 'low', status: 'REVIEW_REQUIRED',
    category: 'request_policy', title: `Request bị chặn: ${item.reason || 'policy'}`,
    location: item.path || null, actual: `${item.method || 'GET'} ${item.path || ''}`,
    expected: 'Kiểm tra lại phạm vi và quyền của request.',
    evidence: [{ kind: 'blocked_request', viewport: item.viewport, reason: item.reason }]
  });
  return assemble(original, findings);
};

export const buildAgentBugReport = (original) => {
  const findings = [];
  for (const testCase of original.cases || []) {
    for (const step of testCase.steps || []) {
      if (step.outcome !== 'PASS') findings.push({
        type: 'test_automation_issue',
        status: 'REVIEW_REQUIRED',
        category: testCase.category, title: `Checkpoint ${step.id}: ${step.description}`,
        testCase: testCase.name, checkpoint: step.id, expected: step.expected,
        actual: `Kết quả bước: ${step.outcome || step.state || 'NOT_TESTED'}`,
        reproductionSteps: [step.description], evidence: step.assertions || []
      });
    }
    if (testCase.kind !== 'flow' && testCase.outcome !== 'PASS') findings.push({
      type: 'test_automation_issue',
      status: 'REVIEW_REQUIRED',
      category: testCase.category, title: `Test case: ${testCase.name}`,
      testCase: testCase.name, expected: testCase.expected,
      actual: `Kết quả: ${testCase.outcome}`,
      evidence: testCase.assertions || []
    });
  }
  for (const item of original.assertions || []) if (item.outcome === 'FAIL') findings.push({
    type: 'defect', status: 'REVIEW_REQUIRED', category: item.category,
    title: `Assertion thất bại: ${item.type}`,
    expected: item.expected, actual: item.actual,
    evidence: [item], location: item.selector || item.path || null
  });
  for (const item of original.actions || []) if (item.success === false) findings.push({
    type: 'test_automation_issue', status: 'REVIEW_REQUIRED', category: 'browser_action',
    title: `Thao tác thất bại: ${item.action || item.type || 'unknown'}`,
    actual: item.error || 'Action failed', evidence: [item]
  });
  for (const item of original.visualFindings || []) findings.push({
    type: item.kind === 'improvement' ? 'improvement' : 'defect',
    status: 'REVIEW_REQUIRED', category: item.category, severity: item.severity,
    title: item.description, expected: item.expected, actual: item.observed || item.description,
    reproductionSteps: item.reproductionSteps, evidence: item.evidence,
    location: item.url, suggestion: item.suggestion
  });
  for (const [group, audits] of [
    ['security', original.securityAudits], ['layout', original.layoutAudits],
    ['accessibility', original.accessibilityAudits]
  ]) for (const audit of audits || []) if (audit.outcome === 'REVIEW_REQUIRED') findings.push({
    type: 'improvement', status: 'REVIEW_REQUIRED', category: group,
    title: `${group} audit cần kiểm tra`, actual: JSON.stringify(audit).slice(0, 1200),
    evidence: [audit]
  });
  for (const item of original.errors || []) findings.push({
    type: 'defect', status: 'REVIEW_REQUIRED', category: 'javascript',
    title: 'Uncaught JavaScript exception', actual: String(item), evidence: [String(item)]
  });
  for (const item of original.blockedRequests || []) findings.push({
    type: 'environment_issue', status: 'REVIEW_REQUIRED', category: 'request_policy',
    title: `Request bị chặn: ${item.reason || 'policy'}`, actual: `${item.method} ${item.path}`,
    evidence: [item]
  });
  if (original.incompleteCase) findings.push({
    type: 'test_automation_issue', status: 'REVIEW_REQUIRED', category: 'workflow',
    title: `Test case chưa kết thúc: ${original.incompleteCase}`
  });
  return assemble(original, findings);
};

const md = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
export const renderBugReportMarkdown = (summary) => {
  const lines = [
    '# Tester Agent — bug report', '',
    `- Dự án: ${md(summary.project)}`,
    `- Chế độ: ${md(summary.mode)}`,
    `- Kết quả gốc: **${md(summary.sourceOutcome)}**`,
    `- Kết quả tổng hợp: **${md(summary.outcome)}**`,
    `- Issues: ${summary.counts.total} (${summary.counts.verified} đã quan sát lỗi; ${summary.counts.needsReview} cần xác minh)`, ''
  ];
  if (!summary.bugs.length) lines.push('Không ghi nhận issue trong phạm vi đã kiểm tra. Kết quả chỉ áp dụng cho các kiểm tra đã thực thi.', '');
  for (const bug of summary.bugs) {
    lines.push(`## ${md(bug.id)} — ${md(bug.title)}`, '',
      `- Loại: ${md(bug.type)} | Mức độ: ${md(bug.severity)} | Trạng thái: ${md(bug.status)}`,
      `- Nhóm: ${md(bug.category)}`,
      `- Test cases: ${md(bug.testCases.join(', ') || 'N/A')} | Checkpoints: ${md(bug.checkpoints.join(', ') || 'N/A')}`,
      `- Vị trí: ${md(bug.location || 'N/A')}`, '',
      `**Expected:** ${md(bug.expected)}`, '', `**Actual:** ${md(bug.actual)}`, '',
      '**Các bước tái hiện:**', '');
    lines.push(...(bug.reproductionSteps.length ? bug.reproductionSteps.map((step, i) => `${i + 1}. ${md(step)}`)
      : ['Chưa có bước tái hiện đầy đủ; cần kiểm tra lại.']));
    lines.push('', '**Bằng chứng:**', '', '```json', JSON.stringify(bug.evidence, null, 2), '```', '');
    if (bug.suggestion) lines.push(`**Đề xuất:** ${md(bug.suggestion)}`, '');
  }
  return lines.join('\n') + '\n';
};

export const writeBugArtifacts = async ({ report, folder, sourceName }) => {
  if (!/^(?:agent|scan)-[\w.-]+\.json$/.test(sourceName)) throw new Error('Tên báo cáo nguồn không hợp lệ.');
  const stem = sourceName.replace(/\.json$/, '-bugs');
  const names = { json: `${stem}.json`, markdown: `${stem}.md` };
  const safeReport = sanitizeBugReport(report);
  const data = [JSON.stringify(safeReport, null, 2) + '\n', renderBugReportMarkdown(safeReport)];
  await mkdir(folder, { recursive: true });
  const paths = [join(folder, names.json), join(folder, names.markdown)];
  const temps = paths.map((path) => `${path}.${process.pid}.${randomUUID()}.tmp`);
  const created = [];
  try {
    for (let i = 0; i < temps.length; i++) {
      await writeFile(temps[i], data[i], { flag: 'wx', mode: 0o600 });
    }
    for (let i = 0; i < temps.length; i++) {
      await rename(temps[i], paths[i]);
      created.push(paths[i]);
    }
  } catch (error) {
    await Promise.all([...temps, ...created].map((path) => unlink(path).catch(() => {})));
    throw error;
  }
  return names;
};
