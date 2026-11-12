#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  listProjectArtifacts, listProjects, readProjectArtifact, registerProject, runGeneric
} from './generic.mjs';
import {
  actBrowser, assertBrowser, auditBrowserAccessibility, auditBrowserLayout, auditBrowserSecurity,
  caseBrowser, finishBrowser, inspectBrowser, recordVisualFinding, resizeBrowser, seeBrowser,
  startBrowser, stepBrowser
} from './browser-agent.mjs';

const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

const server = new McpServer({
  name: 'tester-agent',
  version: packageVersion
});

const resultText = (value, isError = false) => ({
  isError,
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

const safe = (handler) => async (params = {}) => {
  try {
    const data = await handler(params);
    return resultText(data, data?.ok === false);
  } catch (error) {
    return resultText({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, true);
  }
};

const safeImage = async (params = {}) => {
  try {
    const { observation, image } = await seeBrowser(params);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ...observation,
          instruction: 'Đây là ảnh thật của viewport. Hãy quan sát bố cục, màu, chữ, khoảng cách, vùng bị che và vị trí cần click.' }, null, 2) },
        { type: 'image', mimeType: 'image/jpeg', data: image }
      ]
    };
  } catch (error) {
    return resultText({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
  }
};

server.registerTool('tester_register_project', {
  title: 'Đăng ký website cần kiểm thử',
  description: 'Đăng ký một dự án web bất kỳ theo URL. Mặc định chỉ chấp nhận localhost và chỉ đọc. ' +
    'Website QA từ xa cần allowRemote=true. Muốn AI tự bấm form trong QA phải bật allowWrites=true.',
  inputSchema: z.object({
    project: z.string().describe('Tên ngắn duy nhất như my-web, shop-demo.'),
    baseUrl: z.string().url().describe('URL website web local hoặc QA.'),
    environment: z.enum(['local', 'qa']).default('local'),
    allowRemote: z.boolean().default(false),
    allowWrites: z.boolean().default(false),
    allowedOrigins: z.array(z.string().url()).max(6).default([]).describe(
      'Các origin API/CDN cần thiết được cho phép ngoài baseUrl, chỉ dành cho môi trường QA.')
  })
}, safe((params) => registerProject(params)));

server.registerTool('tester_projects', {
  title: 'Danh sách dự án web',
  description: 'Liệt kê dự án đã đăng ký, URL và quyền kiểm thử.',
  inputSchema: z.object({})
}, safe(() => listProjects()));

server.registerTool('tester_test_web', {
  title: 'Tester Agent kiểm thử website',
  description: 'Kiểm tra trang, console, HTTP và responsive bằng Playwright. ' +
    'Dùng tester_browser_* cho các luồng nghiệp vụ có thao tác và assertion.',
  inputSchema: z.object({
    project: z.string(),
    mode: z.literal('scan').default('scan'),
    page: z.string().default('').describe('Đường dẫn tương đối như #/login hoặc /catalog.'),
    maxPages: z.number().int().min(1).max(20).default(5),
    viewports: z.enum(['both', 'desktop', 'mobile']).default('both')
  })
}, safe((params) => runGeneric(params)));

server.registerTool('tester_project_artifacts', {
  title: 'Báo cáo kiểm thử theo dự án',
  description: 'Liệt kê báo cáo QA của một dự án được đăng ký.',
  inputSchema: z.object({
    project: z.string(),
    kind: z.literal('reports').default('reports')
  })
}, safe(({ project, kind }) => listProjectArtifacts(project, kind)));

server.registerTool('tester_project_read_artifact', {
  title: 'Đọc kết quả kiểm thử theo dự án',
  description: 'Đọc báo cáo QA của dự án cụ thể.',
  inputSchema: z.object({
    project: z.string(), kind: z.literal('reports'), name: z.string()
  })
}, safe(({ project, kind, name }) => readProjectArtifact(project, kind, name)));

server.registerTool('tester_browser_start', {
  title: 'AI mở phiên kiểm thử trình duyệt',
  description: 'Mở Chromium theo dự án đã đăng ký. Sau đó gọi tester_browser_see để model thực sự nhìn thấy ảnh website.',
  inputSchema: z.object({
    project: z.string(), page: z.string().default(''), goal: z.string().max(240).default(''),
    viewport: z.enum(['desktop', 'mobile']).default('desktop')
  })
}, safe((args) => startBrowser(args)));

server.registerTool('tester_browser_inspect', {
  title: 'AI quan sát trạng thái website',
  description: 'Trả về nội dung giao diện và lỗi JS hiện tại để AI tự khám phá, sinh bước kiểm thử tiếp theo.',
  inputSchema: z.object({ project: z.string() })
}, safe((args) => inspectBrowser(args)));

server.registerTool('tester_browser_see', {
  title: 'Mắt của AI: nhìn giao diện thật bằng hình ảnh',
  description: 'Trả về JPEG trực tiếp dưới dạng ảnh MCP cùng accessibility tree, kích thước viewport và lỗi JS. ' +
    'Dùng sau khi mở trang hoặc mỗi thao tác để model đa phương thức tự quan sát và phát hiện lỗi giao diện.',
  inputSchema: z.object({ project: z.string() })
}, safeImage);

server.registerTool('tester_browser_resize', {
  title: 'AI đổi kích thước màn hình để kiểm thử responsive',
  description: 'Đổi viewport desktop 1366×768 hoặc mobile 390×844 mà vẫn giữ phiên đăng nhập và trang hiện tại.',
  inputSchema: z.object({ project: z.string(), viewport: z.enum(['desktop', 'mobile']) })
}, safe((args) => resizeBrowser(args)));

server.registerTool('tester_browser_case', {
  title: 'AI bắt đầu hoặc kết thúc một test case',
  description: 'kind=check dành cho kiểm tra đơn giản. kind=flow dành cho E2E, phải khai báo trước các bước ' +
    'và kiểm chứng từng bước bằng tester_browser_step và assertion. Thiếu bước sẽ BLOCKED.',
  inputSchema: z.object({
    project: z.string(), phase: z.enum(['start', 'finish']),
    name: z.string().max(240).default(''), expected: z.string().max(500).default(''),
    category: z.enum(['functional', 'security', 'visual']).default('functional'),
    kind: z.enum(['check', 'flow']).default('check'),
    steps: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/),
      description: z.string().min(1).max(240),
      expected: z.string().min(1).max(500)
    })).max(12).default([])
  })
}, safe((args) => caseBrowser(args)));

server.registerTool('tester_browser_step', {
  title: 'AI kiểm chứng từng bước của luồng E2E',
  description: 'Bắt đầu bước theo thứ tự của tester_browser_case kind=flow, thao tác và kiểm chứng bằng ' +
    'tester_browser_assert, rồi finish bước. Bước không có assertion thực tế sẽ BLOCKED.',
  inputSchema: z.object({
    project: z.string(), phase: z.enum(['start', 'finish']),
    id: z.string().regex(/^[a-zA-Z][\w-]{0,39}$/)
  })
}, safe((args) => stepBrowser(args)));

server.registerTool('tester_browser_security_audit', {
  title: 'AI quan sát cấu hình bảo mật của trang',
  description: 'Kiểm tra thụ động HTTPS, header, cookie phiên và form mật khẩu trên trang đang mở. ' +
    'Không gửi request bổ sung hay thử payload tấn công. Cảnh báo là REVIEW_REQUIRED.',
  inputSchema: z.object({ project: z.string() })
}, safe((args) => auditBrowserSecurity(args)));

server.registerTool('tester_browser_layout_audit', {
  title: 'Đo lỗi tràn ngang ở viewport hiện tại',
  description: 'Đọc chiều rộng trang tại desktop hoặc mobile. Chỉ số tràn ngang cần được đối chiếu với ảnh để nhận định lỗi UI.',
  inputSchema: z.object({ project: z.string() })
}, safe((args) => auditBrowserLayout(args)));

server.registerTool('tester_browser_accessibility_audit', {
  title: 'Kiểm tra dấu hiệu lỗi accessibility trên DOM thực tế',
  description: 'Phát hiện input thiếu nhãn, button/link thiếu tên, ảnh thiếu alt và nhảy cấp heading. ' +
    'Đây là kiểm tra một phần, vấn đề được đánh dấu REVIEW_REQUIRED để model xác minh.',
  inputSchema: z.object({ project: z.string() })
}, safe((args) => auditBrowserAccessibility(args)));

server.registerTool('tester_browser_action', {
  title: 'AI thao tác trình duyệt',
  description: 'Điều hướng, click theo vai trò/CSS hoặc tọa độ từ ảnh, điền input, nhấn phím, hover và cuộn. ' +
    'Click tọa độ, điền và nhấn phím cần allowWrites=true. Chỉ dùng dữ liệu QA giả.',
  inputSchema: z.object({
    project: z.string(), action: z.enum(['navigate', 'click', 'clickAt', 'fill', 'press', 'hover', 'scroll']),
    selector: z.string().max(400).default(''), role: z.string().max(100).default(''),
    name: z.string().max(240).default(''), value: z.string().max(1000).default(''),
    page: z.string().max(220).default(''),
    x: z.number().int().nonnegative().optional(), y: z.number().int().nonnegative().optional(),
    deltaY: z.number().int().min(-3000).max(3000).default(0)
  })
}, safe((args) => actBrowser(args)));

server.registerTool('tester_browser_assert', {
  title: 'AI kiểm chứng kết quả',
  description: 'Xác nhận UI, URL, trạng thái HTTP đã quan sát trong test case hoặc tràn ngang. ' +
    'Mã HTTP không đủ để kết luận phân quyền hoặc nghiệp vụ thành công nếu thiếu kiểm tra trạng thái cuối.',
  inputSchema: z.object({
    project: z.string(), type: z.enum(['visible', 'hidden', 'containsText', 'url',
      'responseStatus', 'noHorizontalOverflow']),
    selector: z.string().max(400).default(''), role: z.string().max(100).default(''),
    name: z.string().max(240).default(''), expected: z.string().max(500).default(''),
    method: z.string().max(12).default('GET'),
    path: z.string().max(300).default('')
  })
}, safe((args) => assertBrowser(args)));

server.registerTool('tester_browser_visual_finding', {
  title: 'AI ghi nhận lỗi giao diện bằng bằng chứng hình ảnh',
  description: 'Sau khi nhìn ảnh qua tester_browser_see, model ghi lỗi bố cục, responsive, màu chữ, khoảng cách, ' +
    'nút che khuất hoặc đề xuất thẩm mỹ. Tự chụp ảnh bằng chứng và đưa vào báo cáo QA theo dự án. ' +
    'Đánh giá thẩm mỹ của AI được đánh dấu REVIEW_REQUIRED.',
  inputSchema: z.object({
    project: z.string(), kind: z.enum(['defect', 'improvement']),
    category: z.enum(['layout', 'responsive', 'contrast', 'typography', 'spacing', 'interaction', 'other']),
    severity: z.enum(['low', 'medium', 'high']),
    description: z.string().min(5).max(500), suggestion: z.string().max(500).default(''),
    observed: z.string().max(500).default(''), expected: z.string().max(500).default(''),
    reproductionSteps: z.array(z.string().max(240)).max(12).default([])
  })
}, safe((args) => recordVisualFinding(args)));

server.registerTool('tester_browser_finish', {
  title: 'Đóng phiên và xuất báo cáo kiểm thử',
  description: 'Ghi lại các thao tác cùng kết quả assertion, trả về PASS/FAIL/BLOCKED và lưu báo cáo đúng dự án.',
  inputSchema: z.object({ project: z.string() })
}, safe((args) => finishBrowser(args)));

const skills = [
  { name: 'qa_senior_tester', folder: 'qa-senior-tester', title: 'Senior QA đa dự án từ browser' },
  { name: 'qa_tester_exploration', folder: 'qa-tester-exploration', title: 'Tester khám phá tự động' },
  { name: 'qa_test_triage', folder: 'qa-test-triage', title: 'Phân loại lỗi từ bằng chứng QA' },
  { name: 'qa_end_to_end_flows', folder: 'qa-end-to-end-flows', title: 'Kiểm thử luồng nghiệp vụ đa dự án' },
  { name: 'qa_responsive_accessibility', folder: 'qa-responsive-accessibility', title: 'Responsive và accessibility' },
  { name: 'qa_security_review', folder: 'qa-security-review', title: 'Quan sát cấu hình bảo mật từ browser' }
];
for (const skill of skills) {
  const skillUrl = new URL('../skills/' + skill.folder + '/SKILL.md', import.meta.url);
  server.registerPrompt(skill.name, {
    title: skill.title,
    description: 'Hướng dẫn QA bằng MCP ' + skill.title
  }, async () => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: await readFile(skillUrl, 'utf8') }
    }]
  }));
  const resourceUri = 'tester://skills/' + skill.folder;
  server.registerResource(skill.name, resourceUri, {
    title: skill.title,
    description: 'Skill QA có thể dùng bởi Codex và Antigravity.',
    mimeType: 'text/markdown'
  }, async () => ({
    contents: [{
      uri: resourceUri,
      mimeType: 'text/markdown',
      text: await readFile(skillUrl, 'utf8')
    }]
  }));
}

const transport = new StdioServerTransport();
await server.connect(transport);
