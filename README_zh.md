> **oncellclaw** — 本仓库是 [NanoClaw](https://github.com/nanocoai/nanoclaw) 的分支，将智能体运行在 [OnCell](https://oncell.ai) 云端单元（cell）中而非本地 Docker。详情请参阅英文 [README](README.md)。

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  一个将智能体安全运行在独立容器中的 AI 助手。轻量、易于理解，并可根据您的需求完全定制。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">文档</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## 我为什么创建 NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) 是一个令人印象深刻的项目，但我无法安心使用一个我不了解、却能访问我个人隐私的复杂软件。OpenClaw 有近 50 万行代码、53 个配置文件和 70+ 个依赖项。其安全性是应用级别的（白名单、配对码），而非真正的操作系统级隔离。所有东西都在一个共享内存的 Node 进程中运行。

NanoClaw 用一个您能轻松理解的代码库提供了同样的核心功能：一个进程，少数几个文件。Claude 智能体运行在具有文件系统隔离的独立 Linux 容器中，而不是仅靠权限检查。

## 快速开始

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash oncellclaw.sh
```

`oncellclaw.sh` 会把您从一台全新机器一直带到一个可以直接发消息的命名智能体。它会在缺失时安装 Node、pnpm 和 Docker，向 OneCLI 注册您的 Anthropic 凭据，构建智能体容器，并配对您的第一个渠道（Telegram、Discord、WhatsApp 或本地 CLI）。如果某一步失败，会自动调用 Claude Code 进行诊断并从中断处继续。

## 设计哲学

**小到可以理解。** 单一进程，少量源文件，无微服务。如果您想了解完整的 NanoClaw 代码库，直接让 Claude Code 给您讲一遍就行。

**通过隔离实现安全。** 智能体运行在 Linux 容器中，只能看到明确挂载的内容。Bash 访问是安全的，因为命令在容器内执行，而不是在您的宿主机上。

**为个人用户打造。** NanoClaw 不是一个单体框架，而是能精确匹配每个用户需求的软件。它被设计成量身定制的，而不是臃肿膨胀。您创建自己的 fork，让 Claude Code 按您的需求修改它。

**定制 = 修改代码。** 没有配置膨胀。想要不同的行为？改代码。代码库小到改动是安全的。

**AI 原生，混合式设计。** 安装与上手流程走的是经过优化的脚本路径，快速且确定。当某一步需要判断（安装失败、引导决策、定制化）时，控制权会无缝地交给 Claude Code。安装之后也不提供监控仪表盘或调试 UI：您在聊天中描述问题，Claude Code 来处理。

**技能优于功能。** 主干只发布注册表和基础设施，不包含具体的渠道适配器或替代智能体提供者。各个渠道（Discord、Slack、Telegram、WhatsApp……）放在长期存在的 `channels` 分支上；替代提供者（OpenCode、Ollama）放在 `providers` 分支上。您运行 `/add-telegram`、`/add-opencode` 等，技能会把您所需要的模块精确地复制到您的 fork 里。不会出现您没要求的功能。

**最强的 harness，最强的模型。** NanoClaw 通过 Anthropic 官方的 Claude Agent SDK 原生使用 Claude Code，所以您能用上最新的 Claude 模型以及 Claude Code 的完整工具集——包括修改和扩展自己的 NanoClaw fork 的能力。其他提供者是可插拔选项：`/add-codex` 对应 OpenAI 的 Codex（ChatGPT 订阅或 API key），`/add-opencode` 通过 OpenCode 接入 OpenRouter、Google、DeepSeek 等，`/add-ollama-provider` 用于本地开源权重模型。提供者可按智能体组单独配置。

## 它能做什么

这里的每一条都是已发布的代码——点开链接就能读到。智能体侧的能力位于 [`container/skills/`](container/skills/) 和 [`container/agent-runner/src/mcp-tools/`](container/agent-runner/src/mcp-tools/)；安装时的能力则是 [`.claude/skills/`](.claude/skills/) 里的斜杠命令。

**随处与它对话**

- **内置网页聊天** — `POST` 一条消息，轮询完整的双向对话记录，或保持一条 Server-Sent-Events 流；自带 Bearer token 认证与速率限制。一个浏览器或一个仪表盘就是完整的客户端。([`src/channels/web.ts`](src/channels/web.ts))
- **Telegram 一步接入** — 用 @BotFather 创建机器人，`POST /web/channels/telegram/pair`，完成。长轮询模式，因此在 NAT 之后和没有 webhook 的托管单元上都能工作。([`src/channels/telegram.ts`](src/channels/telegram.ts))
- **另有十几个渠道以技能提供** — WhatsApp、Discord、Slack、iMessage、Teams、Matrix、Google Chat、Webex、Signal、WeChat、Linear、GitHub、通过 Resend 的邮件：`/add-<channel>` 只把您要的那个适配器精确复制进您的 fork。([`.claude/skills/`](.claude/skills/))
- **一个助手或多个助手** — 为隐私给每个渠道接一个独立智能体，为统一记忆让一个智能体横跨多个渠道，或把多个渠道合并成一场对话。通过 `/manage-channels` 按渠道选择。([docs/isolation-model.md](docs/isolation-model.md))

**您的助手能做什么**

- **浏览网页** — 调研、填表、截图、数据提取、在真实浏览器里测试 Web 应用。([`container/skills/agent-browser`](container/skills/agent-browser/SKILL.md))
- **自己安排自己的工作** — 一次性与 cron 周期任务，各自运行在隔离会话中并留有运行日志；可选的[脚本闸门](docs/scheduled-tasks.md)以极低成本检查是否有新工作，只在有活干时才唤醒智能体。([`src/modules/scheduling/`](src/modules/scheduling/))
- **拉起队友** — `create_agent` 孵化一个拥有独立工作区的长期智能体，双向接线：可以委派任务，也能收到它的消息。任何接好线的一对智能体之间都可以互发消息。([`mcp-tools/agents.ts`](container/agent-runner/src/mcp-tools/agents.ts)、[`src/modules/agent-to-agent/`](src/modules/agent-to-agent/))
- **先问再做** — 特权操作（安装软件包、添加 MCP 服务器、创建智能体）要经过发给管理员的审批卡片；守卫位于投递路径上，而不是寄希望于智能体的善意。([`src/modules/approvals/`](src/modules/approvals/)、[`src/delivery-guard.ts`](src/delivery-guard.ts))
- **正经地向您提问** — 阻塞式多选题，以及在支持的渠道上的富卡片。([`mcp-tools/interactive.ts`](container/agent-runner/src/mcp-tools/interactive.ts))
- **发送真正的产物** — 把文件、图表、PDF 发进聊天；编辑自己已发送的消息；对您的消息做出表情回应。([`mcp-tools/core.ts`](container/agent-runner/src/mcp-tools/core.ts))
- **扩展自己** — 安装 apt/npm 软件包、添加 MCP 服务器、编辑自己的指令与代码（经审批闸门），更大的改动走 builder-agent 模式。([`container/skills/self-customize`](container/skills/self-customize/SKILL.md)、[`mcp-tools/self-mod.ts`](container/agent-runner/src/mcp-tools/self-mod.ts))
- **认真构建 Web 软件** — 前端工程纪律技能强制在真实浏览器中完成构建-测试-验证之后才算"完成"，可与 `/add-vercel` 这类部署技能配合。([`container/skills/frontend-engineer`](container/skills/frontend-engineer/SKILL.md))
- **拥有记忆** — 每个智能体的 `CLAUDE.md` 常设指令，加上一个结构化、有预算控制、跨每次重启存活的记忆索引，在每个会话中重新组装。([`src/claude-md-compose.ts`](src/claude-md-compose.ts)、[`container/agent-runner/src/memory/`](container/agent-runner/src/memory/))
- **管理自己的安装** — 容器内的 `ncl` CLI 可以查询并（经权限闸门）修改渠道、接线、任务与会话。([`src/cli/`](src/cli/))

**幕后机制**

- **比您的笔记本活得久** — 在 OnCell 运行时上，每个智能体的整个世界（记忆、文件、`CLAUDE.md`）都住在一个持久的 gVisor 单元里：笔记本坏了，助手还在。空闲单元以约 $0 的成本暂停到存储；您的下一条消息会唤醒它们。([`src/cell-runner.ts`](src/cell-runner.ts))
- **快照与分叉** — 单元的文件系统可以通过 OnCell API 打检查点或克隆：既能备份一个助手，也能分叉它的完整状态。
- **完全本地的选项** — 不设 `ONCELL_API_KEY`，一切就在本地 Docker 容器中运行，与上游 NanoClaw 完全一致。([`src/container-runner.ts`](src/container-runner.ts))
- **凭据保险库** — 配合 [OneCLI 网关](https://github.com/onecli/onecli)，智能体从不持有原始 API key：凭据在请求时按每个智能体的策略注入，docker 安装还可以把所有出站流量硬锁到网关。([`src/egress-lockdown.ts`](src/egress-lockdown.ts)、[`src/cell-gateway.ts`](src/cell-gateway.ts))
- **从结构上就被沙箱化** — 每个智能体都运行在自己的容器或单元里，只能看到您加入白名单的挂载。([`src/modules/mount-security/`](src/modules/mount-security/))
- **用户、角色与陌生发信人** — 每个用户有 owner/admin/member 角色；陌生人给您的机器人发消息会触发审批卡片，而不是一场对话。([`src/modules/permissions/`](src/modules/permissions/))
- **智能体模板** — 用 `ncl groups create --template <ref>` 冲压出一个开箱即用的智能体（指令 + 工具 + 技能，不含密钥）。([docs/templates.md](docs/templates.md))
- **按智能体选择模型** — 原生使用 Claude Code；`/add-codex`、`/add-opencode`（OpenRouter、Google、DeepSeek……）、`/add-ollama-provider` 用于本地开源权重模型。([`.claude/skills/`](.claude/skills/))

## 托管版（工作原理）

托管版没有单独的代码库。一个托管实例就是*这个*仓库作为服务运行在您自己的 OnCell 单元里，由 [`scripts/cloud-start.sh`](scripts/cloud-start.sh) 启动——与 [oncell.ai/dashboard/claw](https://oncell.ai/claw) 替您运行的是同一个脚本，您也可以在任何能上网的机器上自己运行它。引导过程**只依赖 node**：单元里有 node、npm/corepack 和 tar，但**没有 git、curl、wget 或 python3**——因此源码以 node 抓取的 GitHub tarball 形式到达（先通过 GitHub API 把 `ONCELLCLAW_REF` 解析为 commit sha，再下载并解压 `codeload.github.com/{owner}/{repo}/tar.gz/{sha}` 的 tarball），pnpm 来自 corepack shim，脚本里的每一次下载都走 `node fetch`。一条命令把一台空机器带到一个可用的助手：抓取并解压源码、准备工具链、安装、构建、配置一个接到内置 [`web` 渠道](src/channels/web.ts)的智能体组，最后 `exec` 主机进程，让您的服务监督器接管。

基础目录（`ONCELLCLAW_DIR`，默认 `~/oncellclaw`）把不可变的源码与持久状态分开，因此升级永远不会摧毁您助手的记忆：

```
current -> src-<sha>   正在运行的检出（符号链接，原子切换）
src-<sha>/             某个 commit 的不可变源码树
state/                 data/ groups/ store/ .env — 符号链接进每一个
                       检出；在每次升级中存活
toolchain/             corepack shim（若系统 node 太旧则附带一个私有 node）
```

每个阶段都是幂等的，所以重启会收敛而不是重复：已解压过的 sha 完全不需要下载（固定到完整 sha 的热重启可全程离线启动），新 sha 在旁边解压后再切换 `current`，旧树只在新树完成构建与配置之后才被清理——失败的升级永远不会删掉上一个已知良好的检出。配置阶段会找到它已经创建过的智能体组，而不是再建一个。设 `ONCELLCLAW_RUNTIME=oncell` 时，主机自己的智能体组住在同一账户下的兄弟单元里，主机单元保持为一个轻薄的路由器。`web` 渠道把整场对话放在进程唯一的 HTTP 端口（`$PORT`）上，也就是单元公开预览 URL 所映射的端口：

```bash
# 与它对话
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"hello"}' https://<host>/web/assistant/message          # → 202 {"ok":true,"id":"web-…"}
# 轮询回复（下次把 `cursor` 作为 `after` 传回）
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/messages?after='                      # → 200 {"messages":[…],"cursor":"…"}
# 完整的双向对话（用户行 + 助手行，有序、可续传）
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/transcript?after='                    # → 200 {"messages":[{direction,…}],"cursor":"…"}
# 用推送代替轮询：Server-Sent Events，每行一个 `event: message`
curl -N -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/stream'                               # 先回放，再实时流式推送
curl https://<host>/web/health                                           # → 200 {"ok":true,"groups":[…]}
# 面向仪表盘的自省（token 认证）：version、groups（含运行成本）、channels、skills
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     https://<host>/web/status                                           # → 200 {"version":…,"channels":[…],…}
```

**运行成本：** 每个智能体回合的成本与 token 用量（以 Claude Code 报告的为准）按会话累积在会话数据库里。`/web/status` 按组汇总这本账——`groups[].cost` 为 `{ costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns }`，在记录第一个回合之前为 `null`——每个助手行的对话记录还携带该回合自己的 `costUsd`，因此仪表盘可以渲染一个低调的逐条回复标注。

**首次启动：** 脚本在下载任何东西之前，先用一个极小的占位服务器立即绑定 `$PORT`，因为服务监督器（包括 OnCell 的单元监督器）会在几秒内杀掉不接受连接的服务，而冷安装需要几分钟。引导期间，**所有**路径（包括 `/web/health`）都以 `503` 回答 `{"ok":false,"phase":"…"}`，其中 `phase` 依次经过 `starting → clone → toolchain → install → build → provision → handoff`。随后是占位服务器把端口交给真正主机时短暂的拒绝连接间隙，然后 `/web/health` 返回 `200 {"ok":true,…}`——轮询它直到 `ok` 为 true，就知道助手已经上线。热重启跳过下载与安装，几秒内完成交接。

由于单元里没有 curl，抓取并运行脚本的服务命令本身也只用 node：

```sh
node -e 'const fs=require("fs");const repo=process.env.ONCELLCLAW_REPO||"https://github.com/anupsinghinfra/oncellclaw.git";const ref=process.env.ONCELLCLAW_REF||"main";const m=repo.match(/github\.com[:\/]([^\/]+)\/([^\/]+?)(?:\.git)?$/);if(!m){console.error("cannot parse ONCELLCLAW_REPO: "+repo);process.exit(1)}const url="https://raw.githubusercontent.com/"+m[1]+"/"+m[2]+"/"+ref+"/scripts/cloud-start.sh";fetch(url,{headers:{"User-Agent":"oncellclaw-bootstrap"}}).then(async r=>{if(!r.ok){console.error("HTTP "+r.status+" for "+url);process.exit(1)}const t=await r.text();if(!t.includes("cloud-start.sh")){console.error("unexpected script body from "+url);process.exit(1)}fs.writeFileSync("/tmp/cloud-start.sh",t);console.log("fetched "+url)}).catch(e=>{console.error("fetch failed: "+e);process.exit(1)})' && bash /tmp/cloud-start.sh
```

这个 URL 是公开的，所以 `ONCELLCLAW_WEB_TOKEN` 是互联网与您的助手之间唯一的屏障：除非您为可信的本地网络显式设置 `ONCELLCLAW_WEB_ALLOW_INSECURE=1`，否则该渠道在没有 token 时拒绝启动。这里没有任何东西会把密钥写到磁盘——凭据只在进程环境中传递。该渠道还会自我限流：认证失败按客户端 IP 封顶（默认 20 次/分钟，在 token 比较*之前*检查，所以暴力破解一个泄露的 URL 会撞墙），消息 `POST` 按组封顶（默认 30 次/分钟，允许突发的令牌桶）。超预算的请求得到带 `Retry-After` 头的 `429 {"error":"rate_limited"}`；`GET` 轮询和 `/health` 从不限流。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `ONCELLCLAW_WEB_TOKEN` | — | 每个 `/web/…` 请求的 Bearer token。除非设置了不安全标志，否则**必需**。用 `openssl rand -hex 32` 生成。 |
| `ONCELLCLAW_WEB_ALLOW_INSECURE` | 未设置 | `1` 表示 `web` 渠道无认证运行。仅限本地开发。 |
| `ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN` | `20` | 单个客户端 IP 每分钟允许的认证失败次数，超出后 `/web/…` 回答 `429`（滑动窗口，在 token 比较之前检查）。 |
| `ONCELLCLAW_WEB_MESSAGES_PER_MIN` | `30` | 单个组每分钟接受的消息 `POST` 数（令牌桶；可突发到同一数值）。`GET` 轮询和 `/health` 从不限流。 |
| `PORT` | `3000` | HTTP 监听端口。托管运行时总是由单元监督器设置——回退值仅用于裸机自托管。`WEBHOOK_PORT` 仍可覆盖它。 |
| `ONCELLCLAW_GROUP` | `assistant` | 要配置的智能体组。同时是 URL slug：`/web/<group>/message`。 |
| `ONCELLCLAW_PERSONA` | — | 该组的常设指令，作为其人设只暂存一次。绝不覆盖已被编辑过的版本。 |
| `ONCELLCLAW_REPO` | 本仓库 | 要运行的 GitHub 仓库 URL（tarball 引导——必须是 `github.com`）。 |
| `ONCELLCLAW_REF` | `main` | 分支、标签或 commit sha。完整的 40 位十六进制 sha 会跳过 ref 解析并可离线热重启。 |
| `ONCELLCLAW_DIR` | `$HOME/oncellclaw` | 持久基础目录：`src-<sha>/` 检出、`current` 符号链接、`state/`（`data`、`groups`、`store`、`.env`）和 `toolchain/`。状态在每次升级中存活。 |
| `ONCELLCLAW_RUNTIME` | `oncell` | `oncell` 或 `docker`（见[英文 README 的 Runtimes](README.md#runtimes-oncell-cells-or-local-docker)）。 |
| `ONCELLCLAW_CELL_NAMESPACE` | 安装 slug | 把本实例的智能体组单元（`clawg-{namespace}-{group}`）与同一 OnCell 账户中的其他 claw 隔离。kebab-case，≤24 字符。托管版：仪表盘为每个实例设置唯一值；自托管：默认值（检出路径的 sha1）即可。 |
| `ONCELL_API_KEY` | — | 运行时为 `oncell` 时必需。 |
| `ONCELL_API_URL` | — | 可选的 API 端点覆盖。 |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | 智能体凭据。必须且只能提供其中一个。 |

`web` 渠道并非托管专属——它和 `cli` 一样随主干发布，因此自托管者也可以把浏览器、脚本或自己的前端指向本地的 oncellclaw，用同样的三个端点。参见 [config-examples/hosted.env.example](config-examples/hosted.env.example)。

### 连接 Telegram

主干自带一个零依赖的 Telegram 适配器，运行在**长轮询**模式——不需要公开 webhook，因此在托管单元上和 NAT 之后的笔记本上表现完全一致。用 [@BotFather](https://t.me/BotFather) 创建一个机器人（`/newbot`，复制它打印的 token），然后二选一：

- **仪表盘**：Connections & Integrations → Telegram → Connect → 粘贴 token。该面板是下方 API 的一个薄客户端。
- **API/curl**：

```bash
curl -X POST -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"botToken":"<BotFather 给的 token>"}' https://<host>/web/channels/telegram/pair
# → 200 {"ok":true,"bot":{"username":"YourBot"}}      配对成功；适配器立即上线
# → 400 {"error":"invalid_token"}                     格式不对，或被 Telegram 拒绝
# → 502 {"error":"telegram_unreachable"}              主机无法访问 Telegram API
curl -X DELETE -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" https://<host>/web/channels/telegram
# → 200 {"ok":true}                                   适配器已停止，凭据已移除
```

配对会用 `getMe` 验证 token，把它作为 `TELEGRAM_BOT_TOKEN` 存进安装的 `.env`（与 CLI 安装路径写入的是同一个地方——无论怎样配对都只有一个凭据仓库），并在不重启的情况下启动适配器。`/web/status` 会立即反映（`configured:true, connected:true, detail:"@YourBot"`），并且总是以诚实的状态列出完整的受支持渠道集合（`web`、`cli`、`telegram`、`whatsapp`、`discord`、`imessage`），让仪表盘有地方挂每一个 Connect 按钮。在 Telegram 上给您的机器人发消息，助手就会在那里回答；来自未获批准发信人的私信会走正常的陌生发信人审批流程。

## 使用方法

用触发词（默认为 `@Andy`）与您的助手对话：

```
@Andy 每个工作日早上 9 点给我发一份销售渠道概览（可以访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入就更新它
@Andy 每周一早上 8 点，从 Hacker News 和 TechCrunch 收集 AI 相关资讯，给我发一份简报
```

在您拥有或管理的渠道里，还可以管理群组和任务：
```
@Andy 列出所有群组里的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

NanoClaw 不用配置文件。想改就直接告诉 Claude Code：

- "把触发词改成 @Bob"
- "以后回答请更简短、更直接"
- "我说早上好的时候加一个自定义问候"
- "每周保存一次会话摘要"

或者运行 `/customize` 进行引导式修改。

代码库足够小，Claude 可以安全地修改它。

## 贡献

**不要加功能，要加技能。**

如果您想添加新的渠道或智能体提供者，不要把它加到主干上。新的渠道适配器进入 `channels` 分支；新的智能体提供者进入 `providers` 分支。用户在自己的 fork 上运行 `/add-<name>` 技能，由技能把相关模块复制到标准路径、接好注册、固定依赖版本。

这样主干始终保持为纯粹的注册表和基础设施，每个 fork 也都保持精简——用户只获得他们要求的渠道和提供者，其它什么也不会混进来。

### RFS（技能征集）

我们希望看到的技能：

**通信渠道**
- `/add-signal` — 添加 Signal 作为渠道

## 系统要求

- macOS 或 Linux（Windows 通过 WSL2）
- Node.js 20+ 和 pnpm 10+（安装脚本会在缺失时自动安装）
- [Docker Desktop](https://docker.com/products/docker-desktop)（macOS/Windows）或 Docker Engine（Linux）
- [Claude Code](https://claude.ai/download)，用于 `/customize`、`/debug`、安装过程中的错误恢复以及所有 `/add-<channel>` 技能

## 架构

```
消息应用 → 主机进程（路由器） → inbound.db → 容器（Bun、Claude Agent SDK） → outbound.db → 主机进程（投递） → 消息应用
```

单一 Node 主机编排每个会话的智能体容器。当一条消息到来时，主机按实体模型（用户 → 消息组 → 智能体组 → 会话）进行路由，写入该会话的 `inbound.db`，并唤醒容器。容器内部的 agent-runner 轮询 `inbound.db`，调用 Claude，并把响应写入 `outbound.db`。主机轮询 `outbound.db`，通过渠道适配器投递回去。

每个会话两个 SQLite 文件，每个文件只有一个写入者——没有跨挂载的锁争用，没有 IPC，没有 stdin 管道。渠道和替代提供者在启动时自注册；主干提供注册表和 Chat SDK 桥接，而适配器本身在每个 fork 里通过技能安装。

完整架构说明见 [docs/architecture.md](docs/architecture.md)；三级隔离模型见 [docs/isolation-model.md](docs/isolation-model.md)。

关键文件：
- `src/index.ts` — 入口：数据库初始化、渠道适配器、投递轮询、sweep
- `src/router.ts` — 入站路由：消息组 → 智能体组 → 会话 → `inbound.db`
- `src/delivery.ts` — 轮询 `outbound.db`，通过适配器投递，处理系统动作
- `src/host-sweep.ts` — 60 秒 sweep：失效检测、到期消息唤醒、循环任务
- `src/session-manager.ts` — 解析会话，打开 `inbound.db` / `outbound.db`
- `src/container-runner.ts` — 为每个智能体组启动容器，OneCLI 凭据注入
- `src/db/` — 中心数据库（用户、角色、智能体组、消息组、接线、迁移）
- `src/channels/` — 渠道适配器基础设施（适配器通过 `/add-<channel>` 技能安装）
- `src/providers/` — 主机侧提供者配置（`claude` 内置，其他通过技能安装）
- `container/agent-runner/` — Bun 版 agent-runner：轮询循环、MCP 工具、提供者抽象
- `groups/<folder>/` — 每个智能体组的文件系统（`CLAUDE.md`、技能、容器配置）

## FAQ

**为什么用 Docker？**

Docker 提供跨平台支持（macOS、Linux、Windows via WSL2）和成熟的生态。在 macOS 上，您可以选择通过 `/convert-to-apple-container` 切换到 Apple Container，以获得更轻量的原生运行时。如需更强隔离，[Docker Sandboxes](docs/docker-sandboxes.md) 会把每个容器放到一台微虚拟机里运行。

**我可以在 Linux 或 Windows 上运行吗？**

可以。Docker 是默认运行时，可在 macOS、Linux 以及 Windows（通过 WSL2）上工作。运行 `bash oncellclaw.sh` 就行。

**这个项目安全吗？**

智能体运行在容器里，而不是躲在应用级权限检查之后。它们只能访问明确挂载的目录。凭据不会进入容器——出站 API 请求通过 [OneCLI 的 Agent Vault](https://github.com/onecli/onecli) 在代理层注入认证，并支持速率限制和访问策略。您仍然应该审查自己要运行的代码，但代码库小到您真的能做到。完整的安全模型见 [安全文档](https://docs.nanoclaw.dev/concepts/security)。

**为什么没有配置文件？**

我们不想让配置泛滥。每位用户都应该定制 NanoClaw，让代码精确地做他们想要的事，而不是去配置一个通用系统。如果您更喜欢有配置文件，可以让 Claude 给您加。

**我可以使用第三方或开源模型吗？**

可以。推荐做法是 `/add-opencode`（通过 OpenCode 配置接入 OpenRouter、OpenAI、Google、DeepSeek 等）或 `/add-ollama-provider`（通过 Ollama 使用本地开源权重模型）。两者都可以按智能体组单独配置，所以同一套安装里不同的智能体可以运行在不同的后端上。

对于一次性实验，任何 Claude API 兼容的端点也可以通过 `.env` 使用：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**我该如何调试问题？**

问 Claude Code。"为什么计划任务没运行？""最近的日志里有什么？""为什么这条消息没有得到回复？"这就是 NanoClaw 底层的 AI 原生方式。

**为什么安装对我不成功？**

如果某一步失败，`oncellclaw.sh` 会把控制权交给 Claude Code 进行诊断并从中断处继续。如果还是没解决，运行 `claude`，然后 `/debug`。如果 Claude 发现一个可能影响其他用户的问题，请对相关的安装步骤或技能提 PR。

**什么样的更改会被接受进代码库？**

进入基础配置的只会是：安全修复、bug 修复、明显的改进。仅此而已。

其他一切（新能力、操作系统兼容、硬件支持、增强）都应作为技能贡献到 `channels` 或 `providers` 分支。

这样基础系统保持最小化，每位用户都可以定制自己的安装，而不必继承他们不想要的功能。

## 社区

有问题或想法？欢迎[加入 Discord](https://discord.gg/VDdww8qS42)。

## 更新日志

破坏性变更见 [CHANGELOG.md](CHANGELOG.md)，完整发布历史见文档站的 [full release history](https://docs.nanoclaw.dev/changelog)。

## 许可证

MIT
