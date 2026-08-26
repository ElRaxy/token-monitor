<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor" width="96">
    <h1>Token Monitor × CodexBar</h1>
    <p><strong>Token usage in CodexBar. Provider limits in Token Monitor.</strong></p>
    <p>Two local, opt-in bridges. Each app stays in charge of the data it collects.</p>
    <p>
        <img src="https://img.shields.io/badge/community-fork-22c55e?style=flat-square" alt="Community fork">
        <img src="https://img.shields.io/badge/tested-CodexBar%200.55.1-0A84FF?style=flat-square" alt="Tested with CodexBar 0.55.1">
        <img src="https://img.shields.io/badge/integration-macOS%2014%2B-111827?style=flat-square&logo=apple&logoColor=white" alt="Integration requires macOS 14 or later">
        <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="License: MIT"></a>
    </p>
    <p>
        <a href="#install-the-integration"><strong>Install</strong></a>
        · <a href="#what-this-fork-adds">What this fork adds</a>
        · <a href="docs/codexbar-plugin.md">Setup guide in Spanish</a>
    </p>
</div>

[ElRaxy/token-monitor](https://github.com/ElRaxy/token-monitor) is a community fork of Token Monitor. It adds a small bridge in each direction without combining the applications or their credentials.

## What this fork adds

| Direction | What you see | How it works |
| --- | --- | --- |
| **CodexBar → Token Monitor** | Provider quota limits, labelled `límites y cuotas` in Spanish | Token Monitor reads the authenticated loopback `dashboard-v1` snapshot. The applications stay independent and are not merged; CodexBar remains the owner of provider-limit collection. |
| **Token Monitor → CodexBar** | Today's tokens, this month's tokens and known cost, plus snapshot freshness | A local CodexBar plugin renders the three-row Token Monitor summary. The Spanish UI calls it a `resumen de uso`. |

The two integration directions are independent. They use separate endpoints, credentials and refresh cycles, and serving one endpoint never starts the opposite flow. The Spanish setup guide describes this as <span lang="es">dos flujos de integración independientes</span>.

## Install the integration

> [!IMPORTANT]
> This fork currently runs from source. Official Token Monitor downloads do not include the CodexBar bridge, and this repository does not publish fork-specific binaries yet.

### 1. Run this fork

Requires Node.js 22.15 or later.

```bash
git clone https://github.com/ElRaxy/token-monitor.git
cd token-monitor
npm install
npm start
```

### 2. Enable the summary

In Token Monitor **Settings**, enable the CodexBar summary bridge and copy its dedicated token.

### 3. Install the local provider

Use CodexBar 0.55.1, the version covered by the integration gate. Open **Settings → Plugins → Install…** and select [`integrations/codexbar/token-monitor.js`](integrations/codexbar/token-monitor.js). The same file can be placed manually in `~/.config/codexbar/providers/`.

Set `BASE_URL` to `http://127.0.0.1:17322`, save the copied token as the secure `SUMMARY_TOKEN`, approve that loopback origin and refresh CodexBar. The provider requests only `/api/integrations/codexbar/v1/summary`.

[Read the complete setup, token rotation and troubleshooting guide](docs/codexbar-plugin.md).

## Local by design

- Both bridges use authenticated loopback transport. Invalid or partial configuration fails closed, and CodexBar-owned providers never fall back to duplicate native probes.
- CodexBar receives only aggregate totals, known cost, source count and snapshot time. It does not receive prompts, responses, sessions, projects, models, file paths or Hub data.
- The summary endpoint is cache-only. A read does not start collectors, provider probes, watchers or filesystem scans.
- The two bridges use different bearer tokens. Neither token is written to URLs, command arguments, logs or the renderer.

The full contract and threat model live in the [CodexBar plugin guide](docs/codexbar-plugin.md) and the [CodexBar `dashboard-v1` configuration](docs/configuration.md#codexbar-dashboard-v1-limits).

<details>
<summary><strong>Verified native card capture</strong></summary>

![Token Monitor summary inside CodexBar](.github/assets/codexbar-token-monitor-card.png)

<sub>This public-safe sample data capture records the first native CodexBar 0.55.1 gate. The current provider removes the redundant section heading and keeps the same three rows.</sub>

</details>

## Token Monitor reference

Token Monitor is the local-first desktop widget underneath this fork. The base app tracks usage across 32+ AI coding tools, syncs several devices and keeps prompts, responses and source code on the machine. The upstream project maintains the [full product documentation and translated READMEs](https://github.com/Javis603/token-monitor#readme).

Live token tracking covers Claude Code, Codex, Cursor, GitHub Copilot, Antigravity, OpenCode, and 26+ AI tools. Provider-limit checks cover Claude Code, Codex, Cursor, OpenRouter, third-party APIs, GLM, Kimi, and 21+ providers.

- **WSL usage (Windows)** reads file-backed usage from running distributions; SQLite-backed tools may need a [headless agent inside WSL](docs/wsl-sqlite-setup.md).
- [Configuration reference](docs/configuration.md), including **AI Tool Limits (provider selection, limits, and credentials)**.
- [API contract](docs/API.md) and [data export](docs/export.md).

<details>
<summary><strong>Open the supported-tools matrix</strong></summary>

<br>

## Supported tools

Token Monitor supports token usage, account-limit checks, and session details separately:

| Logo | Tool | Data path | Token Usage | AI Tool Limits | Session Details |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`, `~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/` (`sessions/`, `archived_sessions/`) | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` (`opencode*.db`, `storage/message/`) | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.gemini/` (`antigravity/`, `antigravity-ide/`, `antigravity-backup/`, `antigravity-cli/conversations/`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks (`.../saoudrizwan.claude-dev/tasks/`), `~/.cline/data/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code / Kimi Work | `~/.kimi/sessions/`, `~/.kimi-code/sessions/`, `<platform-app-data>/kimi-desktop/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `~/.grok/` (`sessions/`, `logs/unified.jsonl`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`, `~/.copilot/` (`otel/`, `data.db`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi / Oh My Pi | `~/.pi/agent/sessions/`, `~/.omp/agent/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks (`.../kilocode.kilo-code/tasks/`) — Linux & remote/WSL only | ✅ | — | — |
| <img src=".github/assets/tools-icon/commandcode.png" width="28" alt="Command Code" /> | Command Code | `~/.commandcode/projects/**/*.jsonl` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/` (`projects/`, `cli/db/db.sqlite`) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`, Kiro IDE globalStorage & `kiro-cli` DB | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` + IDE / VS Code extension logs | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`, `~/.workbuddy/workbuddy.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | `<platform-app-data>/QoderCN/SharedClientCache/cache/db/local.db` (CN only) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/reasonix.png" width="28" alt="Reasonix" /> | Reasonix | `~/.reasonix/` (`stats/`, `sessions/`, `projects/*/sessions/`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek / DeepSeek Harness | `~/.dsh/sessions/` (`session.jsonl`, `session.jsonl.zstd`) | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/cherrystudio.png" width="28" alt="Cherry Studio" /> | Cherry Studio | `<platform-app-data>/CherryStudio/` (`Data/Agents/.claude/projects/` V2, `.claude/projects/` legacy) | ✅ | — | — |
| <img src=".github/assets/tools-icon/openrouter.png" width="28" alt="OpenRouter" /> | OpenRouter | OpenRouter API key (usage/key limit; balance when credits access is authorized, documented for Management keys) | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API key (Token Plan quota via Minimax API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key or Volcengine AK/SK (Ark Coding Plan quota via Volcengine API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie (session/weekly usage via ollama.com/settings) | — | ✅ | — |
| <img src=".github/assets/tools-icon/trae.png" width="28" alt="Trae CN" /> | Trae CN | Trae CN access token (Trae CN / SOLO credits via trae.cn) | — | ✅ | — |
| <img src=".github/assets/tools-icon/thirdparty.png" width="28" alt="Third-party APIs" /> | Third-party APIs | New API / Sub2API-compatible account presets (including compatible One API forks), a New API API-key preset, and a Custom balance endpoint | — | ✅ | — |

<details>
<summary><strong>Notes, Custom balance endpoints, and data paths overridden by environment variables</strong></summary>

<br>

- Paths above are the defaults. Token Monitor follows the same environment overrides Tokscale does — `$XDG_DATA_HOME` for the `~/.local/share/` roots, and per-tool variables such as `$CODEX_HOME`, `$GROK_HOME`, `$HERMES_HOME`, `$KIMI_CODE_HOME`, `$DSH_HOME`, `$REASONIX_STATE_HOME`, `$REASONIX_HOME` and the `$CLINE_*` family.

- Command Code transcripts do not contain actual token counts or per-message model metadata. Token usage is estimated from transcript text, while model attribution and derived cost may reflect the currently configured model rather than the model historically used for each request.

- Custom maps numeric JSON fields from one GET balance endpoint; OpenAI or Anthropic compatibility alone is not enough.

#### Qoder CN (local adapter)

Qoder CN token usage is read from the app's local SQLite database, not an API — enable it in Settings → tools (opt-in, off by default). The database is auto-detected per platform: macOS `~/Library/Application Support/QoderCN/SharedClientCache/cache/db/local.db`, Windows `%APPDATA%\QoderCN\SharedClientCache\cache\db\local.db`, Linux `~/.config/QoderCN/SharedClientCache/cache/db/local.db` — overridable with `TOKEN_MONITOR_QODER_CN_DB_PATH`.

This is an advanced local integration: reading needs a `sqlite3` CLI on PATH or a Node runtime with unflagged `node:sqlite` (Node ≥ 23.4; the Electron widget may need the CLI). Read failures are logged, and an existing complete snapshot is retained instead of being replaced with zero usage. Costs are estimated from the models.dev catalog for each mapped model; the adapter may break if Qoder changes its database schema.
</details>

</details>

## Credits and release status

**Credits and licenses.** [Token Monitor](https://github.com/Javis603/token-monitor) was created by [Javis (`Javis603`)](https://github.com/Javis603); [CodexBar](https://github.com/steipete/CodexBar) was created by [Peter Steinberger (`steipete`)](https://github.com/steipete); this integration is maintained by [Alex (`ElRaxy`)](https://github.com/ElRaxy). Both upstream projects use the MIT License. This fork retains Token Monitor's original [MIT license and notices](LICENSE) and links to [CodexBar's MIT License](https://github.com/steipete/CodexBar/blob/main/LICENSE). It is an independent community project. There is no endorsement and no upstream affiliation.

**Releases.** [Fork releases](https://github.com/ElRaxy/token-monitor/releases) are separate from official upstream releases. The official [Token Monitor releases](https://github.com/Javis603/token-monitor/releases) and [CodexBar releases](https://github.com/steipete/CodexBar/releases) do not include this fork's CodexBar integration, and this repository does not currently publish fork-specific binaries. Fork-built installers still inherit Token Monitor's upstream release metadata, so they are not an independent update channel.

Contributions are welcome. Open changes against this fork for the integration, and use each upstream project's own repository for its core product.
