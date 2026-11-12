# Tester Agent

Tester Agent is an open-source MCP server for exploratory web QA. A model in
Codex or Antigravity can inspect a live Chromium page, see its viewport, click
and fill controls, verify outcomes, and export findings for developers. Each
project supplies a URL and its test criteria; there is no project-specific
Playwright script to write.

- **Functional QA:** check single scenarios or complete workflows with ordered
  checkpoints and assertions.
- **Visual QA:** compare desktop and mobile, inspect layout and accessibility
  signals, and attach screenshot evidence to findings.
- **Defensive QA:** observe transport, headers, cookie flags and password forms.
  Verify expected sign-in, sign-out and role behavior through the normal UI
  with QA accounts. This is not a penetration testing tool.

## Install from GitHub

Requires Node.js 24+, npm and the Chromium build installed by Playwright.
The installer targets macOS and Linux; Codex setup uses the `codex` CLI.
If that CLI is unavailable, register the MCP manually in Codex Desktop.

```sh
git clone https://github.com/datb2404981/tester-agent-mcp.git
cd tester-agent-mcp
npm ci
npx playwright install chromium
node scripts/install.mjs --dry-run --only=codex
node scripts/install.mjs --only=codex
```

For Antigravity, use `node scripts/install.mjs --only=antigravity`. Omit
`--only` to install both. Restart Codex Desktop or reload Antigravity's MCP
configuration and open a new chat. If migrating a recognized older Tester
Agent install, preview the change with `--dry-run --replace-managed` first.
The installer also installs six QA skills;
the server exposes those same guides as MCP prompts and resources.

For manual setup, add a stdio server called `tester-agent`. Set the command
to the absolute path to Node (find it with `node -p 'process.execPath'`), and
set its sole argument to the absolute path to `src/server.mjs` in the clone.
The skills are also available in the repository's `skills` directory.

## Try it in a new chat

With your local test app running, replace the URL below with its address:

> Dùng Tester Agent kiểm tra http://localhost:3000. Bắt đầu ở chế độ chỉ đọc.
> Nhìn giao diện trên desktop và mobile, tìm tràn ngang và lỗi trợ năng.
> Ghi rõ các kiểm tra đã làm và xuất báo cáo Markdown cho dev.

For a workflow that changes data, provide the expected outcome, authorized QA
environment and disposable test data. The model drives the browser tool by tool.
The MCP server has no separate model provider or API key; visual judgment
requires an MCP client and model that can consume image results. This version
runs browser QA and read-only scans through the connected model, without an
Explorbot script runner.

Register remote targets with `environment=qa` and `allowRemote=true`. Use
`allowWrites=true` only for authorized test data. Register necessary API or
asset origins in `allowedOrigins`. Page navigation is limited to the
registered site and base path; assets and APIs can use registered origins.
The server stops at HTTP redirects, so flows that require a redirect (such
as some sign-in and SSO flows) are blocked. Use the final URL for read-only
checks where applicable.
Read-only mode limits requests and interaction, but a GET can still have side
effects. Use isolated QA data and review evidence before sharing it. Input
masking and text redaction do not guarantee that a page contains no sensitive data.

## Reports

`tester_browser_finish` and `tester_test_web` return the original report and
a bug report in JSON and Markdown. The default output directory is
`~/.tester-agent/projects/<project>/output/reports`. Set `TESTER_STATE_DIR`
to use a different root. List and read the reports with
`tester_project_artifacts` and `tester_project_read_artifact`.

Each finding carries a severity, expected and actual behavior, reproduction
steps when recorded, evidence, and verification status. `PASS` applies only
to the completed checks. `FAIL` records a failed check or observed error;
`BLOCKED` means execution or evidence was incomplete. `REVIEW_REQUIRED`
marks signals or findings that need judgment. `OBSERVED` describes a passive
audit, without a claim of security or WCAG compliance. A scan does not verify
business workflows.

## Update or remove

To update, run `git pull --ff-only`, `npm ci` and
`npx playwright install chromium` inside the clone. Reload your MCP client.
To remove the server, run `codex mcp remove tester-agent` or remove its entry
from Antigravity's MCP settings. Installed skills and report data can be
removed separately.

Run `npm test` after installing Chromium. The suite runs against a disposable
local website and does not require model credentials.

[MIT license](LICENSE)
