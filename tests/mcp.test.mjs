import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fakePassword = 'fixture-only-password';
let outsideHits = 0;
let nextHopHits = 0;
let signIns = 0;
const site = createServer((req, res) => {
  const html = (body) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>QA fixture</title>' + body);
  };
  if (req.url === '/app/') {
    return html('<h1>Welcome</h1><a href="/app/sign-in">Sign in</a>');
  }
  if (req.url === '/app/sign-in' && req.method === 'POST') {
    signIns++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (new URLSearchParams(body).get('password') !== fakePassword) {
        res.writeHead(400).end('Invalid fixture password');
        return;
      }
      res.setHeader('Set-Cookie', 'fixture_session=1; Path=/app; HttpOnly');
      html('<h1>My account</h1>');
    });
    return;
  }
  if (req.url === '/app/sign-in') {
    return html('<h1>Sign in</h1><form method="post"><label>Password ' +
      '<input name="password" type="password"></label><button>Continue</button></form>');
  }
  if (req.url === '/app/account') {
    return html(req.headers.cookie?.includes('fixture_session=1')
      ? '<h1>My account</h1>' : '<h1>Please sign in</h1>');
  }
  if (req.url === '/app/layout') {
    return html('<h1>Layout</h1><div style="width: 600px">Wide content</div><input>');
  }
  if (req.url === '/app/redirect') {
    return res.writeHead(302, { Location: '/app/next' }).end();
  }
  if (req.url === '/app/next') {
    nextHopHits++;
    return res.writeHead(302, { Location: '/application/outside' }).end();
  }
  if (req.url === '/application/outside') outsideHits++;
  res.writeHead(404).end('Not found');
});

let stateDir, client, baseUrl;
before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'tester-agent-test-'));
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + site.address().port + '/app/';
  client = new Client({ name: 'tester-agent-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...process.env, TESTER_STATE_DIR: stateDir }
  }));
});
after(async () => {
  await client?.close();
  await new Promise((resolve) => site.close(resolve));
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
});

const call = async (name, args, error = false) => {
  const result = await client.callTool({ name: 'tester_' + name, arguments: args });
  const data = JSON.parse(result.content[0].text);
  assert.equal(Boolean(result.isError), error, JSON.stringify(data));
  return data;
};

test('MCP discovers browser tools and all six QA guides', async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.some(({ name }) => name === 'tester_browser_see'));
  assert.ok(tools.some(({ name }) => name === 'tester_browser_finish'));
  assert.equal((await client.listPrompts()).prompts.length, 6);
  assert.equal((await client.listResources()).resources.length, 6);
});

test('readonly scan visits internal links and isolates project reports', async () => {
  await call('register_project', { project: 'reader', baseUrl });
  await call('register_project', { project: 'other', baseUrl });
  const report = await call('test_web', { project: 'reader', maxPages: 2, viewports: 'desktop' });
  assert.equal(report.outcome, 'PASS');
  assert.equal(report.checks[0].exploredCount, 2);
  assert.equal((await call('project_artifacts', { project: 'other' })).length, 0);
  const artifact = await call('project_read_artifact', {
    project: 'reader', kind: 'reports', name: report.bugArtifacts.markdown
  });
  assert.match(artifact.text, /bug report/);
  await call('project_read_artifact', {
    project: 'other', kind: 'reports', name: report.bugArtifacts.markdown
  }, true);
  assert.equal(signIns, 0);
});

test('navigation rejects sibling paths and stops a redirect chain before it leaves scope', async () => {
  for (const page of ['../application/outside', '//example.invalid', 'folder%2Fitem']) {
    const result = await call('browser_start', { project: 'reader', page }, true);
    assert.match(result.error, /phạm vi/);
  }
  const report = await call('test_web', {
    project: 'reader', page: 'redirect', maxPages: 1, viewports: 'desktop'
  }, true);
  assert.equal(report.outcome, 'BLOCKED');
  assert.ok(report.blockedRequests.some(({ reason }) => reason === 'http_redirect'));
  assert.equal(nextHopHits, 0);
  assert.equal(outsideHits, 0);
});

test('model-facing browser tools can observe, sign in, and verify an ordered two-step flow', async () => {
  const project = 'flow';
  await call('register_project', { project, baseUrl, allowWrites: true });
  await call('browser_start', { project });
  const image = await client.callTool({ name: 'tester_browser_see', arguments: { project } });
  assert.equal(image.content[1].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(image.content[1].data, 'base64').readUInt16BE(), 0xffd8);
  await call('browser_case', { project, phase: 'start', kind: 'flow',
    name: 'Sign in', expected: 'Account page opens', steps: [
      { id: 'form', description: 'Open form', expected: 'Sign in heading' },
      { id: 'account', description: 'Submit QA account', expected: 'My account heading' }
    ] });
  await call('browser_step', { project, phase: 'start', id: 'account' }, true);
  await call('browser_step', { project, phase: 'start', id: 'form' });
  await call('browser_action', { project, action: 'click', role: 'link', name: 'Sign in' });
  assert.equal((await call('browser_assert', {
    project, type: 'visible', role: 'heading', name: 'Sign in'
  })).outcome, 'PASS');
  assert.equal((await call('browser_step', { project, phase: 'finish', id: 'form' })).outcome, 'PASS');
  await call('browser_step', { project, phase: 'start', id: 'account' });
  await call('browser_action', { project, action: 'fill', selector: 'input', value: fakePassword });
  await call('browser_action', { project, action: 'click', role: 'button', name: 'Continue' });
  assert.equal((await call('browser_assert', {
    project, type: 'visible', role: 'heading', name: 'My account'
  })).outcome, 'PASS');
  await call('browser_action', { project, action: 'navigate', page: 'account' });
  assert.equal((await call('browser_assert', {
    project, type: 'visible', role: 'heading', name: 'My account'
  })).outcome, 'PASS');
  await call('browser_step', { project, phase: 'finish', id: 'account' });
  assert.equal((await call('browser_case', { project, phase: 'finish' })).outcome, 'PASS');
  const report = await call('browser_finish', { project });
  assert.equal(report.outcome, 'PASS');
  assert.equal(report.cases[0].steps.length, 2);
  assert.equal(signIns, 1);
  for (const name of [report.artifact.name, report.bugArtifacts.markdown, report.bugArtifacts.json]) {
    const data = await readFile(join(stateDir, 'projects', project, 'output', 'reports', name), 'utf8');
    assert.ok(!data.includes(fakePassword));
  }
});

test('missing assertions block a case and a failed report write leaves the session retryable', async () => {
  const project = 'retry';
  await call('register_project', { project, baseUrl });
  await call('browser_start', { project });
  await call('browser_case', { project, phase: 'start', name: 'Check', expected: 'Visible' });
  assert.equal((await call('browser_case', { project, phase: 'finish' })).outcome, 'BLOCKED');
  const output = join(stateDir, 'projects', project, 'output');
  await writeFile(output, 'obstruction');
  await call('browser_finish', { project }, true);
  await rm(output);
  const report = await call('browser_finish', { project });
  assert.equal(report.outcome, 'BLOCKED');
});

test('mobile layout and accessibility findings export separately from a failed check', async () => {
  const project = 'visual';
  await call('register_project', { project, baseUrl });
  await call('browser_start', { project, page: 'layout' });
  await call('browser_resize', { project, viewport: 'mobile' });
  const layout = await call('browser_layout_audit', { project });
  assert.ok(layout.metrics.horizontalOverflowPx > 0);
  assert.ok((await call('browser_accessibility_audit', { project })).issues.some(
    ({ category }) => category === 'input_missing_label'));
  assert.equal((await call('browser_security_audit', { project })).outcome, 'REVIEW_REQUIRED');
  const visual = await call('browser_visual_finding', {
    project, kind: 'defect', category: 'responsive', severity: 'medium',
    description: 'Content overflows on mobile', observed: 'Page scrolls horizontally',
    expected: 'Content fits the viewport', reproductionSteps: ['Open Layout at 390px']
  });
  const evidence = await readFile(join(stateDir, 'projects', project, 'output', 'reports', visual.evidence));
  assert.equal(evidence.readUInt16BE(), 0xffd8);
  await call('browser_case', { project, phase: 'start', name: 'Mobile fit', expected: 'No overflow', category: 'visual' });
  assert.equal((await call('browser_assert', { project, type: 'noHorizontalOverflow' })).outcome, 'FAIL');
  assert.equal((await call('browser_case', { project, phase: 'finish' })).outcome, 'FAIL');
  const report = await call('browser_finish', { project });
  assert.equal(report.outcome, 'FAIL');
  const summary = await call('project_read_artifact', { project, kind: 'reports', name: report.bugArtifacts.json });
  assert.equal(JSON.parse(summary.text).sourceOutcome, 'FAIL');
  assert.match(summary.text, /Content overflows on mobile/);
});
