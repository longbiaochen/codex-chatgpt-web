> ### 这是一个 fork
>
> 上游：**[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)** —— 想用原版请去那边，安装包、各平台发布和支持都在上游。
>
> 这个 fork 只为一种上游明确不支持的部署而存在：**桥跑在与 Codex 不同的机器上**，并且同时驱动多个启动器浏览器。这里的改动都是为这个形态做的，其中几个补丁正是因此被上游拒绝。
>
> - **差异说明：**[这个 fork 改了什么](#这个-fork-改了什么)
> - **发布：** 标签形如 `mars-vX.Y.Z`（上游是 `vX.Y.Z`）。最新：**[mars-v1.0.0](https://github.com/longbiaochen/codex-chatgpt-web/releases/tag/mars-v1.0.0)**，基于上游 v5.0.8。
> - **这里没有安装包。** 发布里只有两个运行时产物（`cli.js`、`browser-helper.cjs`）：先从上游装好应用，再把这两个文件换进去。
> - 与该部署无关的通用修复会提给上游，其余留在 `mars-5.0.8` 分支。

<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="切换到网页版模型，继续使用 Codex。你的 ChatGPT 订阅。你的工作流。充分发挥模型能力。">
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v5.0.8/codex-web-gpt-5.0.8-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases/latest">所有版本</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="ChatGPT Web 实时轮次正在使用原生 Codex harness">
</p>

<p align="center">
  <a href="#get-started">开始使用</a> · <a href="https://github.com/miuuyy/codex-chatgpt-web/releases">更新内容</a> · <a href="docs/architecture.md">架构</a> · <a href="TROUBLESHOOTING.md">故障排除</a>
</p>

在 Codex 原生模型选择器中使用账户可用的 ChatGPT 网页版模型，包括 Pro。使用 ChatGPT 网页版的独立额度，不消耗 Work 或 Codex 额度。保留原有的界面、任务、图片和流式输出。

完整 harness 模式通过 MCP 将 ChatGPT 连接到当前任务的文件、终端、工具和审批流程。对话始终关联到你的 Codex 任务，上下文增长时也能继续工作。

<div id="get-started"><a id="quick-start"></a></div>

## 这个 fork 改了什么

基于上游 **v5.0.8**。一个桥进程服务多个启动器浏览器，每个浏览器有自己的 ChatGPT 连接器和隧道。

### 架构

| 改动 | 为什么 |
| --- | --- |
| **浏览器宿主池** —— 一个桥、多个启动器浏览器；回合分给进行中最少的宿主，保留对话固定在拥有其标签页的那个启动器 | 同一个 Chromium 里，一个渲染进程在吞大提示词时会拖住其他回合的 CDP 连接与重绑 |
| **每宿主独立的连接器名** —— 每个池成员 @ 自己的连接器，各走各的隧道 | OpenAI 在同一条隧道上一次只下发一个工具调用；没有这一步，并发回合会互相排队 |
| **宿主故障回落** —— 主启动器与池成员一视同仁地校验，浏览器 helper 从任一存活启动器启动 | 以前主启动器一停，所有回合都失败，哪怕池里还有活着的成员 |
| **`CODEX_WEB_GPT_BROWSER_HOST_ONLY=1`** —— 启动器只承载浏览器，隐藏安装步骤、Codex 重启提示和 MCP 入口 | 池成员没有自己的配置，它显示的安装向导只可能失败 |

### 修复

- **压缩之后读不到环境信封** —— 压缩后的一轮要么把摘要放在信封和指令之间，要么信封消息本身就是最后一条。两种形态都会让后续每一轮报 `missing cwd in trusted Codex environment context`。
- **远程桥的可视化根目录** —— 接受客户端侧的 `.codex/visualizations/YYYY/MM/DD/<thread>` 结构；桥在另一台机器上时无法用自己的 Codex home 去比对。
- **同线程环境复用** —— 历史信封不再挡住该线程已经受信的权限。
- **重绑与探测的可靠性** —— 同页重绑超时后重试；broker 活动证明回合还活着时不重绑；单页归属检查加上界。
- **卡死回合** —— Codex 从未交回工具结果的回合会被回收，而不是无限心跳。
- **诊断** —— 结构化的 `environment_rejected` 日志写明是哪条分支拒绝了回合，另有启动器连接耗时与重绑前的渲染进程 CPU。上面那两个压缩 bug 就是靠它才定位到的。

逐条提交见[发布说明](https://github.com/longbiaochen/codex-chatgpt-web/releases/tag/mars-v1.0.0)。

### 状态

在一台主机上长期运行：3 轮 × 3 并发回合，9/9 通过，零重绑、零限流。`bun test`：1050 通过，另有 2 个启动器本地化测试在干净的上游检出上同样失败。

没有打包、没有支持，也没在 Windows 和 macOS 上测过——它就是一套恰好值得公开的 Linux 部署。关于宿主池的 issue 和 PR 欢迎提；关于应用本身的请去上游。

## 开始使用

**可用模型：** Free/Go → **Luna / Think**；具有推理控制选项的账户 → **Instant–High**，并按实际可用状态提供 **Extra High** 和 **Pro**。启动器会自动检测账户可用的模型。

1. **安装启动器**：点击上方对应系统的下载按钮。
2. **登录 ChatGPT**：在内置浏览器中登录并运行浏览器冒烟测试。
3. **安装模型**：重启一次 Codex，然后选择 **ChatGPT Web — …** 模型。
4. **需要使用工具编程时**：打开启动器中的 **MCP**，完成下方的完整 harness 设置。

应用已包含浏览器和运行时，无需另外安装 Chrome、Node 或 Bun。

<details>
<summary><strong>命令行安装、更新与修复</strong></summary>

更新前请退出启动器。以下安装脚本会选择正确的平台和架构、验证发布的校验和，并保留 ChatGPT 配置文件和启动器设置。

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
<summary><strong>模型、模式与 MCP 设置</strong></summary>

<a id="modes"></a>

自动模式在账户没有推理选择器时提供 Luna/Think；否则提供 Instant–High，并分别按账户实际可用状态显示 Extra High 和 Pro。

| 模式 | 发送消息 | 本地 Codex 工具 |
| --- | --- | --- |
| **Browser-only** | 自动 | 不支持 |
| **Full harness (With Automation)** | 自动 | 支持，通过 MCP |
| **Zero Risk** | 手动粘贴并发送 | 支持，通过独立 MCP 连接器 |

Zero Risk 不读取或操作 ChatGPT 页面。请自行选择模型和 `Codex Zero Risk` 连接器，粘贴并发送准备好的提示词，再在启动器中确认 **Sent**。自动模式的每个模型条目对应固定的 ChatGPT 模式；Codex 的 Effort 和 Speed 选项不会覆盖它。

<a id="full-harness"></a>

### 完整 harness

完整模式通过官方
[OpenAI tunnel-client](https://github.com/openai/tunnel-client)
将 ChatGPT 的工具调用连接回当前 Codex 任务。该隧道为出站连接：不会暴露公网 IP、开放入站端口，
也不需要配置路由器端口转发。

> **限制**
>
> 有关 **GPT-5.6 Sol Pro** 和 **GPT-6 Astra** 当前的 ChatGPT 消息额度，请参阅
> [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309)。Token 上下文上限取决于
> 账户类型和所选 effort。Plus 的 Medium/High 使用实测的 90,000-token 窗口；启用实验性的
> **3× context** 后最高为 270,000 tokens，并且全程支持原生 Codex compaction。

1. 完成启动器中的必需设置。
2. 在启动器中打开 **MCP**。请在将使用 ChatGPT 连接器的同一个 OpenAI 账户中创建 Tunnel
   和普通 API 密钥；创建密钥本身免费，也不会消耗模型 API 额度。
3. 粘贴 Tunnel ID 和 API 密钥，然后点击 **连接 Harness**。
4. 在 ChatGPT 设置中启用 **开发者模式**。新建连接器时选择 **Tunnel**，选择刚创建的
   Tunnel，将 **身份验证** 设为 **无**，并将名称准确设置为 **Codex Native2**。
5. 在 **Codex Native2** 的 **权限** 中选择 **允许所有操作**；**允许低风险操作** 会在命令和
   补丁到达本地运行时前将其拦截。外层 Codex harness 仍会执行沙箱和审批规则。
6. 运行 **验证运行时**，确认 **Codex Native2** 已连接并可用。

写入/修改操作还需要 ChatGPT 工作区及其管理员政策允许。请参阅
[开发者模式和 MCP 应用](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。
除非显式启用 `--auto-approve-tool-calls`，否则意外的审批提示会直接失败；该选项只会点击
**Allow once**，绝不会授予永久权限。

</details>

<details>
<summary><strong>诊断与子代理</strong></summary>

<a id="operations"></a>

使用 **活动** 页面查看安全的本地诊断，并通过 **设置 → 运行诊断** 执行端到端健康检查。设置页还可
取消保留的浏览器任务，或在卸载前移除 Codex 集成。仅在需要为每个浏览器检查点保存截图时设置
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1`。

新安装默认使用 **Compatibility V1** 以支持跨后端 subagent。**Native** 会保留 Codex 自身的
功能设置，并启用明文 Web-to-Web V2 委派。切换协议后，请重启 Codex 并创建新任务：

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>系统要求与安全</strong></summary>

<a id="limitations-and-security"></a>

- 这是非官方浏览器自动化，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- 浏览器状态是敏感的登录凭据，loopback 监听器也可被同一本地用户运行的进程访问。切勿共享
  启动器 profile，并仅在可信工作站上使用。
- 发布包目前支持 macOS 13+（arm64/x64）、Windows x64 和 Linux x64。运行时、测试和打包会在
  CI 中对三种系统进行检查；依赖账户的浏览器与 MCP 流程使用单独的
  [发布验证](docs/release-validation.md)。
- 构建目前尚未进行平台签名，因此 Gatekeeper 或 SmartScreen 可能会显示警告。安装程序会在安装前
  验证已发布的 SHA-256 清单。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

临时聊天是 [ChatGPT 隐私模式](https://help.openai.com/en/articles/8914046-temporary-chat-faq)，提示词仍由 OpenAI 处理。

验证范围：[发布验证](docs/release-validation.md)。

本项目是独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。请仅使用自己的账户，并遵守适用的
[使用条款](https://openai.com/policies/terms-of-use/)和工作区政策；本项目不会绕过身份验证或
访问控制。

</details>

<details>
<summary><strong>从源码运行与开发</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun run app
```

源码方式需要 Bun 1.4.0。该命令会安装锁定版本的依赖并打开应用。

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` 在 `~/.codex-chatgpt-web-dev` 下使用独立配置和账户。`dev:chat` 使用真实浏览器与压缩流程，并提供明确的模拟工具结果，不改变正常 Codex 路由。设置和命令请参阅 [DEV chat harness](docs/dev-chat.md)。

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

[故障排除](TROUBLESHOOTING.md) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md) · [MIT 许可证](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)

我的另一个项目：<img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — 为 ChatGPT 和 Codex 提供本地、近实时的自定义声音。
