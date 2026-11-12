#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Preserve the stable node_modules symlink rather than pinning pnpm's versioned store path.
const installRoot = resolve(dirname(resolve(process.argv[1] || fileURLToPath(import.meta.url))), '..');
const serverFile = join(installRoot, 'src', 'server.mjs');
const skillsRoot = join(installRoot, 'skills');
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'both';
const dryRun = process.argv.includes('--dry-run');
const replaceManaged = process.argv.includes('--replace-managed');
const serverName = 'tester-agent';
const previousServerName = 'ctulib-tester';
const skillNames = [
  'qa-senior-tester',
  'qa-tester-exploration',
  'qa-test-triage', 'qa-responsive-accessibility', 'qa-end-to-end-flows',
  'qa-security-review'
];

if (!['both', 'codex', 'antigravity'].includes(only)) {
  throw new Error('Dùng --only=codex hoặc --only=antigravity hoặc bỏ qua để cài cả hai.');
}

const executable = (name) => {
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error('Không tìm thấy lệnh ' + name + ' trong PATH.');
  return found.stdout.trim();
};

const nodeBin = executable('node');
const sameNode = (command) => {
  if (typeof command !== 'string') return false;
  if (command === nodeBin) return true;
  try { return realpathSync(command) === realpathSync(nodeBin); }
  catch { return false; }
};

// Recognize only earlier installations of this package, never an unrelated MCP.
const isTesterAgentInstallation = (config) => sameNode(config?.command) &&
  config.args?.length === 1 &&
  /(?:^|\/)(?:packages\/tester-mcp|tester-agent-mcp|node_modules\/@tester-agent\/mcp)\/src\/server\.mjs$/.test(config.args[0]);

const addCodex = (codex, command, args, env) => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  return spawnSync(codex, ['mcp', 'add', serverName, ...envArgs, '--', command, ...args],
    { encoding: 'utf8' });
};

const ensureSkills = async (destination) => {
  for (const name of skillNames) {
    const source = await readFile(join(skillsRoot, name, 'SKILL.md'), 'utf8');
    const target = join(destination, name, 'SKILL.md');
    let current;
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current && current !== source &&
      !current.includes('Nguồn: bộ công cụ ctulib-tester-mcp') &&
      !current.includes('Nguồn: Tester Agent MCP.')) {
      throw new Error('Skill hiện có không thuộc bộ này: ' + target);
    }
    if (!dryRun && current !== source) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, 'utf8');
    }
    console.log((dryRun ? '[xem trước] ' : '') + 'Skill ' + name + ' -> ' + target);
  }
};

const ensureCodex = async () => {
  const codex = executable('codex');
  const isManaged = (config) => sameNode(config.command) &&
    config.args?.[0] === serverFile;
  const existing = spawnSync(codex, ['mcp', 'get', '--json', serverName], { encoding: 'utf8' });
  if (existing.status === 0) {
    const config = JSON.parse(existing.stdout).transport;
    if (!isManaged(config)) {
      if (!replaceManaged || !isTesterAgentInstallation(config)) {
        throw new Error('Codex đã có MCP ' + serverName + ' với cấu hình khác. ' +
          'Dùng --replace-managed để chuyển bản Tester Agent cũ sang bản độc lập.');
      }
      if (dryRun) {
        console.log('[xem trước] Chuyển MCP Tester Agent cũ trong Codex sang ' + serverFile);
      } else {
        const removed = spawnSync(codex, ['mcp', 'remove', serverName], { encoding: 'utf8' });
        if (removed.status !== 0) throw new Error('Không chuyển được MCP Codex: ' + removed.stderr.trim());
        const nextEnv = config.env || {};
        const added = addCodex(codex, nodeBin, [serverFile], nextEnv);
        if (added.status !== 0) {
          const restored = addCodex(codex, config.command, config.args, config.env || {});
          throw new Error('Không chuyển được MCP Codex: ' + added.stderr.trim() +
            (restored.status === 0 ? ' Đã khôi phục cấu hình cũ.' :
              ' KHÔNG khôi phục được cấu hình cũ: ' + restored.stderr.trim()));
        }
        console.log('Đã chuyển MCP Tester Agent trong Codex sang ' + serverFile);
      }
    } else {
      console.log('Codex đã cấu hình MCP ' + serverName + '.');
    }
  } else if (!/not found|không tìm thấy|no MCP server/i.test(existing.stderr)) {
    throw new Error('Không kiểm tra được MCP Codex hiện có: ' + existing.stderr.trim());
  } else if (dryRun) {
    console.log('[xem trước] Thêm MCP ' + serverName + ' vào Codex.');
  } else {
    const added = addCodex(codex, nodeBin, [serverFile], {});
    if (added.status !== 0) throw new Error('Không thêm được Codex MCP: ' + added.stderr.trim());
    console.log('Đã thêm MCP ' + serverName + ' vào Codex.');
  }

  const previous = spawnSync(codex, ['mcp', 'get', '--json', previousServerName], { encoding: 'utf8' });
  if (previous.status === 0 && isManaged(JSON.parse(previous.stdout).transport)) {
    if (dryRun) {
      console.log('[xem trước] Đổi tên MCP ' + previousServerName + ' thành ' + serverName + '.');
    } else {
      const removed = spawnSync(codex, ['mcp', 'remove', previousServerName], { encoding: 'utf8' });
      if (removed.status !== 0) throw new Error('Không xóa được tên MCP cũ: ' + removed.stderr.trim());
      console.log('Đã thay thế tên MCP cũ ' + previousServerName + ' trong Codex.');
    }
  }
};

const ensureAntigravity = async () => {
  const path = join(homedir(), '.gemini', 'config', 'mcp_config.json');
  let current;
  try {
    current = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = {};
  }
  if (!current.mcpServers) current.mcpServers = {};
  const configured = current.mcpServers[serverName];
  const expected = {
    command: nodeBin,
    args: [serverFile],
    timeoutSeconds: 900
  };
  if (configured) {
    if (!sameNode(configured.command) ||
      configured.args?.[0] !== expected.args[0]) {
      if (!replaceManaged || !isTesterAgentInstallation(configured)) {
        throw new Error('Antigravity đã có MCP ' + serverName + ' với cấu hình khác. ' +
          'Dùng --replace-managed để chuyển bản Tester Agent cũ sang bản độc lập.');
      }
      if (dryRun) {
        console.log('[xem trước] Chuyển MCP Tester Agent cũ trong Antigravity sang ' + serverFile);
      } else {
        current.mcpServers[serverName] = {
          ...expected, env: configured.env || {}
        };
      }
    } else {
      console.log('Antigravity đã cấu hình MCP ' + serverName + '.');
    }
  } else if (dryRun) {
    console.log('[xem trước] Thêm MCP ' + serverName + ' vào ' + path);
  } else {
    current.mcpServers[serverName] = expected;
  }

  const previous = current.mcpServers[previousServerName];
  const previousManaged = sameNode(previous?.command) &&
    previous.args?.[0] === serverFile;
  if (previousManaged) {
    if (dryRun) console.log('[xem trước] Đổi tên MCP ' + previousServerName + ' trong Antigravity.');
    else delete current.mcpServers[previousServerName];
  }
  if (dryRun || (configured && !previousManaged &&
    current.mcpServers[serverName] === configured)) return;
  const tempfile = path + '.tester-mcp-tmp-' + process.pid;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempfile, JSON.stringify(current, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(tempfile, path);
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(tempfile).catch(() => {});
    throw error;
  }
  console.log('Đã thêm MCP ' + serverName + ' vào Antigravity.');
};

await access(serverFile);
if (only === 'both' || only === 'codex') {
  await ensureSkills(join(homedir(), '.agents', 'skills'));
  await ensureCodex();
}
if (only === 'both' || only === 'antigravity') {
  await ensureSkills(join(homedir(), '.gemini', 'config', 'skills'));
  await ensureAntigravity();
}
console.log(dryRun ? 'Đã xem trước, cấu hình chưa thay đổi.' :
  'Đã hoàn tất cấu hình. Mở lại ứng dụng để nhận công cụ mới.');
