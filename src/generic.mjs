import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scanSite } from './site-scan.mjs';
import { buildScanBugReport, sanitizeBugReport, writeBugArtifacts } from './bug-report.mjs';
import { isPageInScope } from './scope.mjs';

export const stateRoot = resolve(process.env.TESTER_STATE_DIR || join(homedir(), '.tester-agent'));
const projectsRoot = join(stateRoot, 'projects');
const kinds = new Set(['reports']);
const projectIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const artifactNamePattern = /^[\p{L}\p{N}_-][\p{L}\p{N}\p{M}_.-]*\.(?:md|json)$/u;

export const validateProjectId = (project) => {
  if (typeof project !== 'string' || !projectIdPattern.test(project)) {
    throw new Error('Tên dự án dùng chữ thường, số và dấu gạch nối (tối đa 48 ký tự).');
  }
  return project;
};

const isLoopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export const validateTarget = (input, allowRemote = false) => {
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('URL website không hợp lệ.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !parsed.hostname) {
    throw new Error('baseUrl phải là HTTP(S), không chứa tài khoản, query hoặc fragment.');
  }
  if (!isLoopback(parsed.hostname) && !allowRemote) {
    throw new Error('Website ngoài máy local cần allowRemote=true và phải là môi trường QA được phép kiểm thử.');
  }
  return parsed.href.replace(/\/+$/, '');
};

const validateAllowedOrigins = (origins, allowRemote) => {
  if (!Array.isArray(origins) || origins.length > 6) {
    throw new Error('Chỉ cho phép tối đa 6 origin bổ sung.');
  }
  return [...new Set(origins.map((origin) => {
    const url = validateTarget(origin, allowRemote);
    const parsed = new URL(url);
    if (parsed.pathname !== '/' || url !== parsed.origin) {
      throw new Error('allowedOrigins chỉ nhận origin (scheme, host, port), không có đường dẫn.');
    }
    return parsed.origin;
  }))];
};

const projectDirectory = (project) => join(projectsRoot, validateProjectId(project));
const projectFile = (project) => join(projectDirectory(project), 'project.json');
const outputDirectory = (project) => join(projectDirectory(project), 'output');

export const registerProject = async ({ project, baseUrl, allowRemote = false,
  allowWrites = false, environment = 'local', allowedOrigins = [] }) => {
  validateProjectId(project);
  const url = validateTarget(baseUrl, allowRemote);
  if (!['local', 'qa'].includes(environment)) throw new Error('environment phải là local hoặc qa.');
  if (!isLoopback(new URL(url).hostname) && environment !== 'qa') {
    throw new Error('Website từ xa phải khai báo environment=qa.');
  }
  if (typeof allowWrites !== 'boolean' || typeof allowRemote !== 'boolean') {
    throw new Error('allowWrites và allowRemote phải là boolean.');
  }
  const origins = validateAllowedOrigins(allowedOrigins, allowRemote);
  if (origins.length && !isLoopback(new URL(url).hostname) && environment !== 'qa') {
    throw new Error('Origin bổ sung từ xa chỉ dùng trong môi trường QA.');
  }
  const config = { project, baseUrl: url, allowRemote, allowWrites, environment,
    allowedOrigins: origins };
  const folder = projectDirectory(project);
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `project-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, projectFile(project));
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { ...config, output: outputDirectory(project) };
};

export const getProject = async (project) => {
  let data;
  try { data = JSON.parse(await readFile(projectFile(project), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Chưa đăng ký dự án ${project}. Dùng tester_register_project.`);
    throw error;
  }
  if (data.project !== project) throw new Error('Cấu hình dự án không khớp.');
  validateTarget(data.baseUrl, data.allowRemote);
  return { ...data, allowedOrigins: validateAllowedOrigins(data.allowedOrigins || [], data.allowRemote) };
};

export const listProjects = async () => {
  let entries;
  try { entries = await readdir(projectsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const configs = [];
  for (const item of entries) {
    if (item.isDirectory() && projectIdPattern.test(item.name)) {
      try { configs.push(await getProject(item.name)); }
      catch { /* Ignore incomplete project registrations. */ }
    }
  }
  return configs.sort((a, b) => a.project.localeCompare(b.project));
};

export const resolvePageUrl = (config, page = '') => {
  if (typeof page !== 'string' || page.length > 220 || /[\r\n\\]/.test(page)) {
    throw new Error('Đường dẫn trang không hợp lệ.');
  }
  const base = new URL(config.baseUrl.replace(/\/+$/, '') + '/');
  const target = new URL(page.replace(/^\//, ''), base);
  if (!isPageInScope(target, base) || target.search || page.startsWith('//')) {
    throw new Error('Trang phải nằm trong phạm vi baseUrl của dự án.');
  }
  return target.href;
};

const redact = (text) => {
  let value = String(text);
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(PASSWORD|TOKEN|API_KEY|SECRET|AUTH)/i.test(key) && secret?.length >= 6) {
      value = value.replaceAll(secret, '[REDACTED]');
    }
  }
  return value.replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [REDACTED]');
};

export const listProjectArtifacts = async (project, kind = 'reports') => {
  await getProject(project);
  if (!kinds.has(kind)) throw new Error('Loại báo cáo không hợp lệ.');
  const directory = join(outputDirectory(project), kind);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const stats = await stat(join(directory, entry.name));
      return { name: entry.name, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
    }));
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 30);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

export const readProjectArtifact = async (project, kind, name) => {
  await getProject(project);
  if (!kinds.has(kind) || typeof name !== 'string' || basename(name) !== name ||
      !artifactNamePattern.test(name)) {
    throw new Error('Tên báo cáo không hợp lệ.');
  }
  const root = join(outputDirectory(project), kind);
  const [actualRoot, path] = await Promise.all([realpath(root), realpath(join(root, name))]);
  if (!path.startsWith(actualRoot + sep)) throw new Error('Báo cáo nằm ngoài phạm vi dự án.');
  const body = await readFile(path, 'utf8');
  return { project, kind, name, text: redact(body.slice(0, 40000)), truncated: body.length > 40000 };
};

export const runGeneric = async ({ project, mode = 'scan', page = '', maxPages = 5, viewports = 'both' }) => {
  if (mode !== 'scan' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 ||
      !['both', 'desktop', 'mobile'].includes(viewports)) {
    throw new Error('Chế độ, giới hạn số trang hoặc viewport không hợp lệ.');
  }
  const config = await getProject(project);
  const url = resolvePageUrl(config, page);
  const sizes = viewports === 'both' ? ['desktop', 'mobile'] : [viewports];
  const checks = [];
  for (const viewport of sizes) {
    checks.push({ viewport, ...await scanSite({ url, baseUrl: config.baseUrl, maxPages,
      mobile: viewport === 'mobile', allowedOrigins: config.allowedOrigins }) });
  }
  const issues = checks.flatMap((check) => check.issues.map((issue) =>
    ({ ...issue, viewport: check.viewport })));
  const blockedRequests = checks.flatMap((check) => check.blockedRequests.map((request) =>
    ({ ...request, viewport: check.viewport })));
  const outcome = ['FAIL', 'BLOCKED', 'REVIEW_REQUIRED'].find((status) =>
    checks.some((check) => check.outcome === status)) || 'PASS';
  const report = JSON.parse(JSON.stringify(sanitizeBugReport({ project, mode, url, viewports, checks,
    ok: outcome === 'PASS', outcome, issues, blockedRequests }), (_, item) =>
    typeof item === 'string' ? redact(item) : item));
  const folder = join(outputDirectory(project), 'reports');
  await mkdir(folder, { recursive: true });
  const name = `scan-${randomUUID()}.json`;
  await writeFile(join(folder, name), JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  const bugArtifacts = await writeBugArtifacts({
    folder, sourceName: name, report: buildScanBugReport(report)
  });
  return { ...report, artifact: { kind: 'reports', name },
    bugArtifacts: { kind: 'reports', ...bugArtifacts } };
};
