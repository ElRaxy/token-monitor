# Configuration

Token Monitor has two configuration surfaces:

- **Widget (GUI)** — everything the desktop app does, configured from the `⚙` settings panel. This is the only surface most people need.
- **`.env`** — for the headless agent and standalone hub, which have no UI.

The widget reads `.env` values as *first-run defaults*; once you change a setting in the GUI, the saved value takes over. The agent and hub follow the precedence **CLI flag → env var (real or `.env`) → built-in default**.

---

## Widget (GUI)

Click the `⚙` button in the bottom-right corner of the widget to open the settings panel. Sections appear in this order:

| Section | What it controls |
|---|---|
| **General** | Language, launch at login, app updates, Discord Rich Presence, About, and Advanced (open the raw `settings.json` for less-common options such as `allTimeSince`). |
| **Main** | Which Home modules appear and their order, plus the display currency (USD, TWD, HKD, or CNY; daily auto rate or a manual override). |
| **Window** | Window behavior (float above other apps / normal / desktop-pinned), tray mode (macOS menu bar or Windows system tray, and what shows next to the icon), the floating bubble, and the global show/hide shortcut. |
| **Appearance** | Interface theme (presets such as Default and Obsidian, a porcelain light mode, or custom colors), per-vendor tool colors, and system glass opacity / blur. |
| **Collection** | Tracked tools (and hide / pin / drag-reorder for the main list), collection cadence, **Keep usage from deleted sessions**, custom pricing, data export, and — on Windows — the built-in WSL scan toggle. |
| **AI Tool Limits** | Which providers to enable, their credentials and sign-in options, multiple accounts per provider (including switching the active local Codex account), session / weekly / billing / credit windows, and how often to refresh. |
| **Subscriptions** | What you actually pay for each AI account — a recurring plan, or a top-up ledger for balance-style accounts — surfaced on hover of that account's plan label. Entered by hand; nothing is fetched from any provider. With a hub configured the list is stored on the hub and shared by every connected device; otherwise it stays in this device's `settings.json`. |
| **Multi-device Sync** | **Local only** (no hub), **Connect to a hub** (paste another machine's Hub URL + secret), or **Host hub on this device** (run a hub locally; the panel lists reachable LAN / Tailscale / ZeroTier addresses). |

The `⇧` button in the title bar cycles the window behavior.

---

## Headless agent & hub (`.env`)

The agent and hub have no UI. Configure them with a `.env` file in the project root (copy it from `.env.example`):

```env
TOKEN_MONITOR_HUB_URL=               # required in sync mode — Worker URL or http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # shared secret; must match the hub
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to the hostname
TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS= # optional — 0/live, 600000/10min, 1200000/20min, 1800000/30min
TOKEN_MONITOR_CLIENTS=               # optional — defaults to all supported tools; empty disables tracking
TOKEN_MONITOR_PROJECTS_ENABLED=      # optional — defaults off; 1 collects project metadata
TOKEN_MONITOR_HISTORY_ENABLED=       # optional — defaults on; 0 skips trend history
TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED= # optional — defaults on; 0 stops archiving deleted-session usage
TOKEN_MONITOR_LIMITS_ENABLED=        # optional — defaults on; 0 skips CLI probing
TOKEN_MONITOR_LIMIT_PROVIDERS=       # optional — defaults to all supported providers
TOKEN_MONITOR_CODEXBAR_URL=          # optional — HTTP loopback dashboard-v1 base URL
TOKEN_MONITOR_CODEXBAR_TOKEN=        # optional — dashboard bearer; never put it in argv
TOKEN_MONITOR_CODEXBAR_PROVIDERS=    # optional — canonical delegated provider IDs
TOKEN_MONITOR_LIMITS_REFRESH_MODE=   # optional — fixed (default) or adaptive
TOKEN_MONITOR_LIMITS_REFRESH_MS=     # optional — interval for fixed mode; defaults to 300000
# WorkBuddy: the desktop widget auto-detects the signed-in local app when the
# provider is enabled.
# The following are an advanced/headless-agent fallback, not normal widget setup.
# Desktop Local App monitoring is available on macOS and Windows; Linux Local
# App monitoring is unsupported. Desktop users do
# not copy a token, and Token Monitor does not store the WorkBuddy app credential.
TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN= # headless only — explicit billing-session token
TOKEN_MONITOR_WORKBUDDY_USER_ID=      # headless only — WorkBuddy user ID
TOKEN_MONITOR_WORKBUDDY_ENTERPRISE_ID= # headless only — selects enterprise billing
TOKEN_MONITOR_WORKBUDDY_DOMAIN=      # headless only — X-Domain metadata
TOKEN_MONITOR_WORKBUDDY_DEPARTMENT_INFO= # headless only — enterprise metadata
TOKEN_MONITOR_WORKBUDDY_LOCALE=       # headless only — en or zh
```

Provider credentials (Grok, DeepSeek, Minimax, Copilot, GLM / GLM Team, Volcengine, Qoder, Command Code, WorkBuddy, Ollama, Kimi, …) and proxy settings live in the same file. **`.env.example` is the complete, authoritative list** — start from it rather than copying keys by hand, since it stays in sync with the code. The desktop widget automatically reads the session owned by the local WorkBuddy app when that provider is enabled; the WorkBuddy token fields above remain only for headless/CLI deployments.

The widget reads most settings as first-run defaults. WorkBuddy follows the same provider checkbox as other auto-detected integrations on macOS and Windows; Linux local-app monitoring is unsupported. Desktop users do not copy a token, and the WorkBuddy token fields above apply only to the headless agent/CLI. The agent and hub take a CLI flag over an env var over the built-in default.

### CodexBar dashboard-v1 limits

The CodexBar integration is opt-in and disabled by default. In the widget, configure it inside **AI Tool Limits → CodexBar Dashboard**. For the headless agent, set `TOKEN_MONITOR_CODEXBAR_URL`, `TOKEN_MONITOR_CODEXBAR_TOKEN`, and `TOKEN_MONITOR_CODEXBAR_PROVIDERS`; supplying only part of the configuration fails closed instead of enabling it.

Run the persistent `codexbar serve` process on an HTTP loopback address such as `http://127.0.0.1:8080` or `http://localhost:8080`. Token Monitor requests the fixed `/dashboard/v1/snapshot` endpoint and sends the secret as `Authorization: Bearer <token>`. LAN hosts, HTTPS URLs, query credentials, and secrets in command-line arguments are not accepted by this integration.

```bash
# Load this value from a password manager or another private environment source.
export CODEXBAR_DASHBOARD_TOKEN='replace-with-a-long-random-secret'
codexbar serve --host 127.0.0.1 --port 8080 --identity redacted
```

Use the same bearer in Token Monitor. Keep it in the environment or the widget's private credential store; do not pass it through CodexBar's `--dashboard-token` flag because process listings can expose command-line arguments.

For each delegated provider, CodexBar is the single owner and Token Monitor never runs that provider's native probe. Removing a provider from the delegated list returns ownership to Token Monitor through a configuration change; an upstream error does not trigger an implicit native fallback.

The CodexBar integration does not import token usage, costs, sessions, projects, history, or account credentials. Token Monitor consumes only normalized provider-limit windows and keeps its existing usage, cost, and session collectors authoritative.

Account identity must arrive redacted from CodexBar. Token Monitor ignores dashboard identity and account objects, and never derives a stable account key from a redacted email or label.

Canonical delegated provider IDs are `claude`, `codex`, `opencode`, `cursor`, `antigravity`, `kimi`, `grok`, `copilot`, `commandcode`, `mimo`, `zai`, `kiro`, `qoder`, `deepseek`, `openrouter`, `minimax`, `volcengine`, and `ollama`. The incoming dashboard alias `doubao` can normalize to `volcengine`, but `doubao` is rejected in Token Monitor configuration; configure `volcengine` explicitly.

`codexbar dashboard` is a one-shot diagnostic command, not a poller, and must never be placed in Token Monitor's refresh loop. Keep `codexbar serve` running for normal collection.

One-shot run (collect once and exit — useful for cron / launchd):

```bash
npm run agent -- --clients=claude,codex,opencode --once
```
