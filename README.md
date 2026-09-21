> ### This is a fork
>
> Upstream: **[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)** — if you want the original, go there. It is the one with installers, releases for every platform, and support.
>
> This fork exists for one deployment upstream explicitly does not support: **the bridge running on a different machine than Codex**, serving several launcher browsers at once. Everything here is built for that shape, and several patches were declined upstream for exactly that reason.
>
> - **What is different:** [What this fork changes](#what-this-fork-changes)
> - **Releases:** tagged `mars-vX.Y.Z` (upstream uses `vX.Y.Z`). Latest: **[mars-v1.0.0](https://github.com/longbiaochen/codex-chatgpt-web/releases/tag/mars-v1.0.0)**, based on upstream v5.0.8.
> - **No installers here.** Releases ship only the two runtime bundles (`cli.js`, `browser-helper.cjs`). Install the app from upstream, then swap those two files in.
> - Changes are offered upstream when they are not specific to this deployment; the rest stays on the `mars-5.0.8` branch.

<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">What’s new</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex’s native model picker—with ChatGPT Web’s separate usage limits, without spending your Work or Codex quota. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your Codex task, so you can keep working as the context grows.

<div id="get-started"><a id="quick-start"></a></div>

## What this fork changes

Based on upstream **v5.0.8**. One bridge process serves several launcher browsers, each with its own ChatGPT connector and tunnel.

### Architecture

| Change | Why |
| --- | --- |
| **Browser host pool** — one bridge, several launcher browsers; turns go to the host with the fewest in flight, and a retained conversation stays on the launcher owning its tab | A renderer busy ingesting a large prompt used to stall CDP attach and rebinding for every other turn in the same Chromium |
| **Per-host connector names** — each pool browser mentions its own connector, so each has its own tunnel | OpenAI dispatches one tool call at a time per tunnel; without this, concurrent turns queue behind each other |
| **Host failover** — the primary launcher is validated like any pool member, and the browser helper starts from whichever launcher is alive | Stopping the primary used to fail every turn, even with live pool members |
| **`CODEX_WEB_GPT_BROWSER_HOST_ONLY=1`** — a launcher that hosts the browser but hides the install step, the Codex restart notice and the MCP entry points | A pool host has no config of its own; the setup wizard it showed could only ever fail |

### Fixes

- **Environment after a compaction** — a compacted turn either puts the summary between the envelope and the instruction, or makes the envelope message itself the last item. Both left every following turn failing with `missing cwd in trusted Codex environment context`.
- **Remote-bridge visualization roots** — accept the client-side `.codex/visualizations/YYYY/MM/DD/<thread>` layout, which a bridge on another host cannot verify against its own Codex home.
- **Same-thread environment reuse** — historical envelopes no longer block a thread's already-trusted authority.
- **Rebind and probe reliability** — retry a timed-out same-page rebind; do not rebind a stalled DOM probe while broker activity proves the turn is alive; bound per-page ownership inspection.
- **Abandoned turns** — retire browser turns whose tool batch Codex never answered instead of heartbeating forever.
- **Diagnostics** — a structured `environment_rejected` line naming which branch refused a turn, plus launcher connect timings and renderer CPU before a rebind. The compaction bugs above were only findable because of it.

Commit-level detail is in the [release notes](https://github.com/longbiaochen/codex-chatgpt-web/releases/tag/mars-v1.0.0).

### Status

Runs in production on one host: 3 rounds x 3 concurrent turns, 9/9, zero rebinds, zero rate limiting. `bun test`: 1050 pass, plus 2 launcher-localization flakes that also fail on a clean upstream checkout.

Not packaged, not supported, and not tested on Windows or macOS — it is a Linux deployment that happens to be useful to publish. Issues and PRs about the pool are welcome; anything about the app itself belongs upstream.

## Get started

**Available models:** Free/Go → **Luna / Think**. Accounts with reasoning controls → **Instant–High**, plus **Extra High** and **Pro** when available. The launcher detects what your account can use.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models**, restart Codex once, and choose a **ChatGPT Web — …** model.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

**macOS / Linux**

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `Codex Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic model entries each select a fixed ChatGPT mode; Codex’s Effort and Speed rows do not override it.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window, or
> up to 270,000 tokens with experimental **3× context** enabled, with native Codex compaction
> supported throughout.

1. Finish the required setup, open **MCP**, create the Tunnel and regular API key, then press
   **Connect harness**.
2. Enable ChatGPT **Developer Mode** and create a new Tunnel connector named exactly
   **Codex Native2**, with **Authentication: None** and **Allow all actions**.
3. Run **Verify runtime** to confirm that **Codex Native2** is attached and available.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings can also cancel a retained browser turn or remove the Codex integration before uninstall.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Temporary Chat is a [ChatGPT privacy mode](https://help.openai.com/en/articles/8914046-temporary-chat-faq); prompts are still processed by OpenAI.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal Codex route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

## Star History

<a href="https://www.star-history.com/?repos=miuuyy%2Fcodex-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=miuuyy/codex-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

Also by me: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — local, near-real-time custom voices for ChatGPT and Codex.
