> **oncellclaw** — 이 저장소는 에이전트를 Docker 대신 [OnCell](https://oncell.ai) 셀에서 실행하는 [NanoClaw](https://github.com/nanocoai/nanoclaw) 포크입니다. 자세한 내용은 영어 [README](README.md)를 참조하세요.

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  에이전트를 각자의 컨테이너에서 안전하게 실행하는 AI 어시스턴트입니다. 가볍고, 쉽게 이해할 수 있으며, 여러분의 필요에 맞게 완전히 커스터마이즈할 수 있도록 만들어졌습니다.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">문서</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## NanoClaw를 만든 이유

[OpenClaw](https://github.com/openclaw/openclaw)는 인상적인 프로젝트지만, 제가 이해하지 못하는 복잡한 소프트웨어에 제 삶 전체에 대한 접근 권한을 줬다면 저는 잠을 이루지 못했을 것입니다. OpenClaw는 거의 50만 줄에 달하는 코드, 53개의 설정 파일, 70개 이상의 의존성을 가지고 있습니다. 보안은 진정한 OS 수준의 격리가 아니라 애플리케이션 수준(허용 목록, 페어링 코드)에 의존합니다. 모든 것이 메모리를 공유하는 하나의 Node 프로세스에서 실행됩니다.

NanoClaw는 그와 동일한 핵심 기능을 제공하지만, 이해할 수 있을 만큼 작은 코드베이스로 구현합니다. 하나의 프로세스와 몇 개의 파일뿐입니다. Claude 에이전트는 단순한 권한 검사 뒤가 아니라, 파일시스템이 격리된 각자의 Linux 컨테이너에서 실행됩니다.

## 빠른 시작

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash oncellclaw.sh
```

`oncellclaw.sh`는 갓 준비한 머신에서 시작해 메시지를 보낼 수 있는 이름 붙은 에이전트까지 안내합니다. 누락된 경우 Node, pnpm, Docker를 설치하고, Anthropic 자격 증명을 OneCLI에 등록하며, 에이전트 컨테이너를 빌드하고, 첫 채널(Telegram, Discord, WhatsApp 또는 로컬 CLI)을 페어링합니다. 어떤 단계가 실패하면 Claude Code가 자동으로 호출되어 원인을 진단하고 중단된 지점부터 재개합니다.

<details>
<summary><strong>NanoClaw v1에서 마이그레이션하시나요?</strong></summary>

기존 v1 설치 옆에 새로운 v2 체크아웃을 만들어 실행하세요:

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh`는 v1 설치(형제 디렉터리, 또는 `NANOCLAW_V1_PATH=/path/to/nanoclaw`)를 찾아 상태를 v2 체크아웃으로 마이그레이션한 다음, 판단이 필요한 부분(소유자 시딩, 공유 메모리 마이그레이션, 포크 커스터마이징 재적용)을 마무리하기 위해 Claude Code로 `exec`합니다.

이 스크립트는 Claude 세션 내부가 아니라 직접 실행하세요. 결정론적인 부분에서 Node/pnpm 부트스트랩, Docker, OneCLI, 컨테이너 빌드를 위해 대화형 프롬프트와 실제 셸 I/O가 필요합니다.

**무엇을 하는가:** `.env`를 병합하고, `registered_groups`로부터 v2 DB를 시딩하며, 그룹 폴더 + 세션 데이터 + 예약 작업을 복사하고, 선택한 채널 어댑터를 설치하며, 채널 인증 상태(WhatsApp의 Baileys 키스토어 + LID 매핑 포함)를 복사하고, 에이전트 컨테이너를 빌드합니다.

**무엇을 하지 않는가:** 시스템 서비스를 전환하지 않습니다. 프롬프트에서 *"switch to v2"*를 선택하거나, 테스트 후 수동으로 전환하세요. 기존 v1 설치는 그대로 유지됩니다.

무엇이 달라졌는지는 [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md)를, 개발 노트는 [docs/migration-dev.md](docs/migration-dev.md)를 참고하세요.

</details>

## 철학

**이해할 수 있을 만큼 작게.** 하나의 프로세스, 몇 개의 소스 파일, 마이크로서비스 없음. NanoClaw 코드베이스 전체를 이해하고 싶다면 Claude Code에게 안내해 달라고 요청하기만 하면 됩니다.

**격리를 통한 보안.** 에이전트는 Linux 컨테이너에서 실행되며 명시적으로 마운트된 것만 볼 수 있습니다. 명령이 호스트가 아니라 컨테이너 안에서 실행되기 때문에 Bash 접근도 안전합니다.

**개별 사용자를 위해 설계.** NanoClaw는 거대한 단일 프레임워크가 아니라, 각 사용자의 정확한 필요에 맞는 소프트웨어입니다. 비대한 소프트웨어가 되는 대신, NanoClaw는 맞춤형이 되도록 설계되었습니다. 직접 포크를 만들고 Claude Code가 여러분의 필요에 맞게 수정하도록 합니다.

**커스터마이징 = 코드 변경.** 설정의 난립이 없습니다. 다른 동작을 원하시나요? 코드를 수정하세요. 코드베이스가 충분히 작아서 안전하게 변경할 수 있습니다.

**AI 네이티브, 설계상 하이브리드.** 설치와 온보딩 흐름은 최적화된 스크립트 경로로, 빠르고 결정론적입니다. 어떤 단계에 판단이 필요할 때 — 설치 실패, 안내가 필요한 결정, 커스터마이징 등 — 제어권이 Claude Code로 매끄럽게 넘어갑니다. 설정 이후에도 모니터링 대시보드나 디버깅 UI가 없습니다. 채팅으로 문제를 설명하면 Claude Code가 처리합니다.

**기능보다 스킬.** 트렁크는 특정 채널 어댑터나 대체 에이전트 프로바이더가 아니라 레지스트리와 인프라를 제공합니다. 채널(Discord, Slack, Telegram, WhatsApp, …)은 오래 유지되는 `channels` 브랜치에, 대체 프로바이더(OpenCode, Ollama)는 `providers` 브랜치에 있습니다. `/add-telegram`, `/add-opencode` 등을 실행하면 스킬이 여러분이 필요로 하는 모듈만 정확히 포크로 복사합니다. 요청하지 않은 기능은 없습니다.

**최고의 하니스, 최고의 모델.** NanoClaw는 Anthropic의 공식 Claude Agent SDK를 통해 Claude Code를 네이티브로 사용하므로, 최신 Claude 모델과 Claude Code의 전체 도구 세트를 누릴 수 있습니다. 여기에는 자신의 NanoClaw 포크를 직접 수정하고 확장하는 능력도 포함됩니다. 다른 프로바이더는 드롭인 옵션입니다. OpenAI의 Codex는 `/add-codex`(ChatGPT 구독 또는 API 키), OpenRouter·Google·DeepSeek 등은 OpenCode를 통한 `/add-opencode`, 로컬 오픈 웨이트 모델은 `/add-ollama-provider`로 추가합니다. 프로바이더는 에이전트 그룹별로 설정할 수 있습니다.

## 할 수 있는 일

여기 적힌 항목은 전부 실제로 배포되어 있는 코드입니다 — 링크를 따라가 직접 읽어 보세요. 에이전트 측 기능은 [`container/skills/`](container/skills/)와 [`container/agent-runner/src/mcp-tools/`](container/agent-runner/src/mcp-tools/)에, 설치 시점 기능은 [`.claude/skills/`](.claude/skills/)의 슬래시 명령에 있습니다.

**어디서든 대화하기**

- **웹 채팅 기본 내장** — 메시지를 `POST`하고, 양방향 대화 기록 전체를 폴링하거나, Server-Sent-Events 스트림을 열어 두세요. Bearer 토큰 인증과 속도 제한이 포함되어 있습니다. 브라우저나 대시보드 하나면 완전한 클라이언트가 됩니다. ([`src/channels/web.ts`](src/channels/web.ts))
- **Telegram은 한 번 붙여넣기로** — @BotFather로 봇을 만들고 `POST /web/channels/telegram/pair` 하면 끝. 롱 폴링 방식이므로 NAT 뒤에서도, webhook이 없는 호스티드 셀에서도 똑같이 동작합니다. ([`src/channels/telegram.ts`](src/channels/telegram.ts))
- **십여 개의 채널이 스킬로 더** — WhatsApp, Discord, Slack, iMessage, Teams, Matrix, Google Chat, Webex, Signal, WeChat, Linear, GitHub, Resend를 통한 이메일: `/add-<channel>`이 여러분이 요청한 어댑터만 정확히 여러분의 포크로 복사합니다. ([`.claude/skills/`](.claude/skills/))
- **어시스턴트는 하나든 여럿이든** — 프라이버시를 위해 채널마다 전용 에이전트를 연결하거나, 통합된 메모리를 위해 하나의 에이전트를 여러 채널에서 공유하거나, 여러 채널을 하나의 대화로 합칠 수 있습니다. `/manage-channels`로 채널별로 선택하세요. ([docs/isolation-model.md](docs/isolation-model.md))

**어시스턴트가 하는 일**

- **웹을 탐색합니다** — 리서치, 폼 입력, 스크린샷, 데이터 추출, 실제 브라우저를 통한 웹 앱 테스트. ([`container/skills/agent-browser`](container/skills/agent-browser/SKILL.md))
- **자기 일을 스스로 예약합니다** — 단발성 및 cron 반복 작업을 각각 격리된 세션과 실행 로그로 관리합니다. 선택적인 [스크립트 게이트](docs/scheduled-tasks.md)가 새 작업이 있는지 저렴하게 확인해, 일이 있을 때만 에이전트를 깨웁니다. ([`src/modules/scheduling/`](src/modules/scheduling/))
- **팀 동료를 만들어 냅니다** — `create_agent`가 자체 작업 공간을 가진 새 장수 에이전트를 탄생시키고 양방향으로 연결합니다. 위임하고, 메시지를 돌려받으세요. 연결된 어떤 쌍 사이에서든 에이전트 간 메시징이 동작합니다. ([`mcp-tools/agents.ts`](container/agent-runner/src/mcp-tools/agents.ts), [`src/modules/agent-to-agent/`](src/modules/agent-to-agent/))
- **행동하기 전에 허락을 구합니다** — 특권 작업(패키지 설치, MCP 서버 추가, 에이전트 생성)은 관리자에게 가는 승인 카드를 거칩니다. 가드는 에이전트의 선의가 아니라 전달 경로에 있습니다. ([`src/modules/approvals/`](src/modules/approvals/), [`src/delivery-guard.ts`](src/delivery-guard.ts))
- **제대로 질문합니다** — 블로킹 방식의 객관식 질문과, 지원되는 채널에서는 리치 카드. ([`mcp-tools/interactive.ts`](container/agent-runner/src/mcp-tools/interactive.ts))
- **진짜 산출물을 보냅니다** — 파일, 차트, PDF를 채팅으로. 자신이 보낸 메시지를 수정하고, 여러분의 메시지에 반응도 합니다. ([`mcp-tools/core.ts`](container/agent-runner/src/mcp-tools/core.ts))
- **스스로를 확장합니다** — apt/npm 패키지 설치, MCP 서버 추가, 자신의 지침과 코드 편집(승인 게이트 적용). 더 큰 변경에는 빌더 에이전트 패턴을 사용합니다. ([`container/skills/self-customize`](container/skills/self-customize/SKILL.md), [`mcp-tools/self-mod.ts`](container/agent-runner/src/mcp-tools/self-mod.ts))
- **웹 소프트웨어를 진지하게 만듭니다** — 프런트엔드 엔지니어링 규율 스킬이 "완료" 전에 실제 브라우저에서의 빌드-테스트-검증을 강제하며, `/add-vercel` 같은 배포 스킬과 짝을 이룹니다. ([`container/skills/frontend-engineer`](container/skills/frontend-engineer/SKILL.md))
- **기억합니다** — 에이전트별 `CLAUDE.md` 상시 지침에 더해, 모든 재시작을 견디는 구조화되고 예산이 관리되는 메모리 인덱스가 세션마다 새로 합성됩니다. ([`src/claude-md-compose.ts`](src/claude-md-compose.ts), [`container/agent-runner/src/memory/`](container/agent-runner/src/memory/))
- **자기 설치를 스스로 관리합니다** — 컨테이너 안의 `ncl` CLI가 채널, 연결, 작업, 세션을 조회하고 (권한 게이트를 거쳐) 수정합니다. ([`src/cli/`](src/cli/))

**내부 동작**

- **노트북보다 오래 삽니다** — OnCell 런타임에서는 각 에이전트의 세계 전체(메모리, 파일, `CLAUDE.md`)가 내구성 있는 gVisor 셀에 존재합니다. 노트북이 죽어도 어시스턴트는 죽지 않습니다. 유휴 셀은 ~$0로 스토리지에 일시 정지되고, 다음 메시지가 깨웁니다. ([`src/cell-runner.ts`](src/cell-runner.ts))
- **스냅샷과 포크** — 셀의 파일시스템은 OnCell API로 체크포인트하거나 복제할 수 있습니다. 어시스턴트를 백업하거나 전체 상태를 포크하세요.
- **완전 로컬 옵션** — `ONCELL_API_KEY`가 없으면 모든 것이 업스트림 NanoClaw와 똑같이 로컬 Docker 컨테이너에서 실행됩니다. ([`src/container-runner.ts`](src/container-runner.ts))
- **자격 증명 금고** — [OneCLI 게이트웨이](https://github.com/onecli/onecli)와 함께라면 에이전트는 원시 API 키를 절대 보유하지 않습니다. 자격 증명은 요청 시점에 에이전트별 정책과 함께 주입되며, docker 설치에서는 모든 아웃바운드 트래픽을 게이트웨이로 강제 고정할 수 있습니다. ([`src/egress-lockdown.ts`](src/egress-lockdown.ts), [`src/cell-gateway.ts`](src/cell-gateway.ts))
- **구조적으로 샌드박스** — 모든 에이전트는 자기만의 컨테이너 또는 셀에서 실행되며, 여러분이 허용 목록에 넣은 마운트만 봅니다. ([`src/modules/mount-security/`](src/modules/mount-security/))
- **사용자, 역할, 낯선 발신자** — 사용자별 owner/admin/member 역할. 모르는 사람이 봇에게 메시지를 보내면 대화가 아니라 승인 카드가 발동됩니다. ([`src/modules/permissions/`](src/modules/permissions/))
- **에이전트 템플릿** — `ncl groups create --template <ref>`로 바로 실행 가능한 에이전트(지침 + 도구 + 스킬, 비밀 정보 없음)를 찍어 냅니다. ([docs/templates.md](docs/templates.md))
- **에이전트별 모델 선택** — Claude Code는 네이티브. `/add-codex`, `/add-opencode`(OpenRouter, Google, DeepSeek…), 로컬 오픈 웨이트 모델은 `/add-ollama-provider`. ([`.claude/skills/`](.claude/skills/))

## 호스티드는 이렇게 동작합니다

호스티드용 별도 코드베이스는 없습니다. 호스티드 인스턴스란 *이* 저장소가 여러분 자신의 OnCell 셀 안에서 서비스로 실행되는 것으로, [`scripts/cloud-start.sh`](scripts/cloud-start.sh)가 시작합니다 — [oncell.ai/dashboard/claw](https://oncell.ai/claw)가 여러분 대신 실행해 주는 것과 같은 스크립트이며, 인터넷이 되는 어떤 머신에서든 직접 실행할 수도 있습니다. 부트스트랩은 **node만으로** 이루어집니다: 셀에는 node, npm/corepack, tar는 있지만 **git, curl, wget, python3는 없습니다**. 그래서 소스는 node가 가져오는 GitHub tarball로 도착하고(`ONCELLCLAW_REF`를 GitHub API로 커밋 sha로 해석한 뒤 `codeload.github.com/{owner}/{repo}/tar.gz/{sha}` tarball을 내려받아 풉니다), pnpm은 corepack shim에서 오며, 스크립트의 모든 다운로드는 `node fetch`를 거칩니다. 명령 하나가 빈 머신을 살아 있는 어시스턴트로 만듭니다: 소스 가져오기와 압축 해제, 툴체인 준비, 설치, 빌드, 내장 [`web` 채널](src/channels/web.ts)에 페어링된 에이전트 그룹 프로비저닝, 마지막으로 호스트를 `exec`해 슈퍼바이저가 프로세스를 소유하게 합니다.

베이스 디렉터리(`ONCELLCLAW_DIR`, 기본값 `~/oncellclaw`)는 불변 소스와 내구성 있는 상태를 분리하므로, 업데이트가 어시스턴트의 기억을 파괴하는 일은 결코 없습니다:

```
current -> src-<sha>   실행 중인 체크아웃(심볼릭 링크, 원자적으로 전환)
src-<sha>/             커밋 하나의 불변 소스 트리
state/                 data/ groups/ store/ .env — 모든 체크아웃에
                       심볼릭 링크되며, 어떤 업데이트에도 살아남음
toolchain/             corepack shim(시스템 node가 오래됐다면 전용 node 포함)
```

모든 단계는 멱등이므로 재시작해도 중복되지 않고 수렴합니다: 이미 풀려 있는 sha라면 다운로드가 전혀 없고(전체 sha에 고정된 웜 리스타트는 완전히 오프라인으로 부팅), 새 sha는 옆에 풀린 뒤 `current`가 전환되며, 옛 트리는 새 트리가 빌드와 프로비저닝을 마친 후에만 정리됩니다 — 실패한 업데이트가 마지막으로 정상이었던 체크아웃을 지우는 일은 없습니다. 프로비저닝은 이미 만들어 둔 에이전트 그룹을 찾아 재사용하지, 두 번째를 만들지 않습니다. `ONCELLCLAW_RUNTIME=oncell`이면 호스트 자신의 에이전트 그룹은 같은 계정 아래 형제 셀에 살고, 호스트 셀은 얇은 라우터로 남습니다. `web` 채널은 대화 전체를 프로세스의 단일 HTTP 포트(`$PORT`)에 올리며, 이것이 셀의 공개 미리보기 URL에 매핑됩니다:

```bash
# 말 걸기
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"hello"}' https://<host>/web/assistant/message          # → 202 {"ok":true,"id":"web-…"}
# 답장 폴링(다음번에는 `cursor`를 `after`로 돌려보내기)
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/messages?after='                      # → 200 {"messages":[…],"cursor":"…"}
# 양방향 대화 전체(사용자 행 + 어시스턴트 행, 정렬됨, 이어받기 가능)
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/transcript?after='                    # → 200 {"messages":[{direction,…}],"cursor":"…"}
# 폴링 대신 푸시: Server-Sent Events, 행마다 하나의 `event: message`
curl -N -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/stream'                               # 리플레이 후 라이브 스트림
curl https://<host>/web/health                                           # → 200 {"ok":true,"groups":[…]}
# 대시보드용 인트로스펙션(토큰 인증): version, groups(실행 비용 포함), channels, skills
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     https://<host>/web/status                                           # → 200 {"version":…,"channels":[…],…}
```

**실행 비용:** 각 에이전트 턴의 비용과 토큰 사용량(Claude Code가 보고하는 값)이 세션별로 세션 DB에 누적됩니다. `/web/status`는 이 장부를 그룹 단위로 합산하고 — `groups[].cost`는 `{ costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns }`이며 첫 턴이 기록되기 전에는 `null` — 각 어시스턴트 행의 대화 기록에는 해당 턴 자신의 `costUsd`가 실리므로, 대시보드가 답장마다 은은한 주석을 렌더링할 수 있습니다.

**첫 부팅:** 스크립트는 무언가를 내려받기 전에 아주 작은 자리표시자 서버로 `$PORT`를 즉시 바인딩합니다. 서비스 슈퍼바이저(OnCell 셀 슈퍼바이저 포함)는 몇 초 안에 연결을 받지 않는 서비스를 죽이는데, 콜드 설치는 몇 분이 걸리기 때문입니다. 부트스트랩이 도는 동안 (`/web/health`를 포함한) **모든** 경로가 `503`으로 `{"ok":false,"phase":"…"}`를 답하며, `phase`는 `starting → clone → toolchain → install → build → provision → handoff` 순으로 진행됩니다. 자리표시자가 실제 호스트에 포트를 넘기는 짧은 연결 거부 구간이 이어진 뒤 `/web/health`가 `200 {"ok":true,…}`을 반환합니다 — `ok`가 true가 될 때까지 폴링하면 어시스턴트가 살아났음을 알 수 있습니다. 웜 리스타트는 다운로드와 설치를 건너뛰고 몇 초 만에 넘겨줍니다.

셀에는 curl이 없으므로, 스크립트를 가져와 실행하는 서비스 명령 자체도 node만 사용합니다:

```sh
node -e 'const fs=require("fs");const repo=process.env.ONCELLCLAW_REPO||"https://github.com/anupsinghinfra/oncellclaw.git";const ref=process.env.ONCELLCLAW_REF||"main";const m=repo.match(/github\.com[:\/]([^\/]+)\/([^\/]+?)(?:\.git)?$/);if(!m){console.error("cannot parse ONCELLCLAW_REPO: "+repo);process.exit(1)}const url="https://raw.githubusercontent.com/"+m[1]+"/"+m[2]+"/"+ref+"/scripts/cloud-start.sh";fetch(url,{headers:{"User-Agent":"oncellclaw-bootstrap"}}).then(async r=>{if(!r.ok){console.error("HTTP "+r.status+" for "+url);process.exit(1)}const t=await r.text();if(!t.includes("cloud-start.sh")){console.error("unexpected script body from "+url);process.exit(1)}fs.writeFileSync("/tmp/cloud-start.sh",t);console.log("fetched "+url)}).catch(e=>{console.error("fetch failed: "+e);process.exit(1)})' && bash /tmp/cloud-start.sh
```

그 URL은 공개되어 있으므로, 인터넷과 여러분의 어시스턴트 사이에 있는 것은 `ONCELLCLAW_WEB_TOKEN`뿐입니다: 신뢰할 수 있는 로컬 네트워크를 위해 명시적으로 `ONCELLCLAW_WEB_ALLOW_INSECURE=1`을 설정하지 않는 한, 채널은 토큰 없이는 시작을 거부합니다. 여기서 비밀 정보가 디스크에 쓰이는 일은 없습니다 — 자격 증명은 프로세스 환경 안에서만 이동합니다. 채널은 스스로 속도 제한도 겁니다: 인증 실패는 클라이언트 IP당 상한(기본 20회/분, 토큰 비교 *전에* 검사되므로 유출된 URL에 대한 무차별 대입은 벽에 부딪힙니다), 메시지 `POST`는 그룹당 상한(기본 30회/분, 버스트 친화적인 토큰 버킷). 예산을 넘긴 요청은 `Retry-After` 헤더가 붙은 `429 {"error":"rate_limited"}`를 받습니다. `GET` 폴링과 `/health`는 결코 제한되지 않습니다.

| 변수 | 기본값 | 의미 |
|---|---|---|
| `ONCELLCLAW_WEB_TOKEN` | — | 모든 `/web/…` 요청의 Bearer 토큰. insecure 플래그를 설정하지 않는 한 **필수**. `openssl rand -hex 32`로 생성. |
| `ONCELLCLAW_WEB_ALLOW_INSECURE` | 미설정 | `1`이면 `web` 채널을 인증 없이 실행. 로컬 개발 전용. |
| `ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN` | `20` | 한 클라이언트 IP가 분당 시도할 수 있는 인증 실패 횟수. 초과 시 `/web/…`이 `429`로 응답(슬라이딩 윈도, 토큰 비교 전에 참조). |
| `ONCELLCLAW_WEB_MESSAGES_PER_MIN` | `30` | 한 그룹이 분당 받아들이는 메시지 `POST` 수(토큰 버킷, 같은 수까지 버스트 가능). `GET` 폴링과 `/health`는 무제한. |
| `PORT` | `3000` | HTTP 수신 포트. 호스티드 실행에서는 항상 셀 슈퍼바이저가 설정 — 폴백은 순수 자가 호스팅 전용. `WEBHOOK_PORT`가 여전히 우선. |
| `ONCELLCLAW_GROUP` | `assistant` | 프로비저닝할 에이전트 그룹. URL 슬러그이기도 합니다: `/web/<group>/message`. |
| `ONCELLCLAW_PERSONA` | — | 해당 그룹의 상시 지침. 페르소나로 한 번만 스테이징되며, 편집된 것을 덮어쓰지 않음. |
| `ONCELLCLAW_REPO` | 이 저장소 | 실행할 GitHub 저장소 URL(tarball 부트스트랩 — `github.com`이어야 함). |
| `ONCELLCLAW_REF` | `main` | 브랜치, 태그 또는 커밋 sha. 40자리 전체 sha면 ref 해석을 건너뛰고 오프라인으로 웜 리스타트. |
| `ONCELLCLAW_DIR` | `$HOME/oncellclaw` | 영속 베이스: `src-<sha>/` 체크아웃, `current` 심볼릭 링크, `state/`(`data`, `groups`, `store`, `.env`), `toolchain/`. 상태는 모든 업데이트에서 살아남음. |
| `ONCELLCLAW_RUNTIME` | `oncell` | `oncell` 또는 `docker`([영문 README의 Runtimes](README.md#runtimes-oncell-cells-or-local-docker) 참고). |
| `ONCELLCLAW_CELL_NAMESPACE` | 설치 슬러그 | 이 인스턴스의 에이전트 그룹 셀(`clawg-{namespace}-{group}`)을 같은 OnCell 계정의 다른 claw로부터 격리. 케밥 케이스, 24자 이하. 호스티드: 대시보드가 인스턴스마다 고유한 값을 설정. 자가 호스팅: 기본값(체크아웃 경로의 sha1)이면 충분. |
| `ONCELL_API_KEY` | — | 런타임이 `oncell`일 때 필수. |
| `ONCELL_API_URL` | — | 선택적 API 엔드포인트 오버라이드. |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | 에이전트 자격 증명. 정확히 하나가 필요. |

`web` 채널은 호스티드 전용이 아닙니다 — `cli`처럼 main에 함께 배포되므로, 자가 호스팅 사용자도 브라우저, 스크립트, 자체 프런트엔드를 같은 세 엔드포인트로 로컬 oncellclaw에 연결할 수 있습니다. [config-examples/hosted.env.example](config-examples/hosted.env.example)을 참고하세요.

### Telegram 연결하기

main에는 의존성이 전혀 없는 Telegram 어댑터가 **롱 폴링** 모드로 함께 배포됩니다 — 공개 webhook이 필요 없으므로 호스티드 셀에서든 NAT 뒤의 노트북에서든 동일하게 동작합니다. [@BotFather](https://t.me/BotFather)로 봇을 만들고(`/newbot`, 출력된 토큰 복사) 다음 중 하나를 하세요:

- **대시보드**: Connections & Integrations → Telegram → Connect → 토큰 붙여넣기. 이 패널은 아래 API의 얇은 클라이언트입니다.
- **API/curl**:

```bash
curl -X POST -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"botToken":"<BotFather가 준 토큰>"}' https://<host>/web/channels/telegram/pair
# → 200 {"ok":true,"bot":{"username":"YourBot"}}      페어링 완료. 어댑터는 즉시 가동
# → 400 {"error":"invalid_token"}                     형식 오류, 또는 Telegram이 거부
# → 502 {"error":"telegram_unreachable"}              호스트에서 Telegram API에 도달 불가
curl -X DELETE -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" https://<host>/web/channels/telegram
# → 200 {"ok":true}                                   어댑터 중지, 자격 증명 제거
```

페어링은 토큰을 `getMe`로 검증하고, 설치의 `.env`에 `TELEGRAM_BOT_TOKEN`으로 저장하며(CLI 설정 경로가 쓰는 곳과 같은 자리 — 어떤 방식으로 페어링하든 자격 증명 저장소는 하나), 재시작 없이 어댑터를 시작합니다. `/web/status`는 이를 즉시 반영하고(`configured:true, connected:true, detail:"@YourBot"`), 지원되는 전체 채널 목록(`web`, `cli`, `telegram`, `whatsapp`, `discord`, `imessage`)을 항상 정직한 상태로 나열하므로 대시보드는 모든 Connect 버튼을 걸어 둘 행을 갖게 됩니다. Telegram에서 봇에게 메시지를 보내면 어시스턴트가 그곳에서 답합니다. 승인하지 않은 발신자의 DM은 통상적인 낯선 발신자 승인 흐름을 거칩니다.

## 사용법

트리거 단어(기본값: `@Andy`)로 어시스턴트에게 말을 거세요:

```
@Andy 매주 평일 오전 9시에 영업 파이프라인 개요를 보내줘 (내 Obsidian 보관함 폴더에 접근 가능)
@Andy 매주 금요일에 지난 한 주간의 git 히스토리를 검토하고, 내용이 어긋나면 README를 업데이트해줘
@Andy 매주 월요일 오전 8시에 Hacker News와 TechCrunch에서 AI 관련 소식을 모아 브리핑을 보내줘
```

여러분이 소유하거나 관리하는 채널에서는 그룹과 작업을 관리할 수 있습니다:
```
@Andy 모든 그룹에 걸친 예약 작업을 전부 나열해줘
@Andy 월요일 브리핑 작업을 일시 정지해줘
@Andy Family Chat 그룹에 참여해줘
```

## 커스터마이징

NanoClaw는 설정 파일을 사용하지 않습니다. 변경하려면 Claude Code에게 원하는 것을 말하기만 하면 됩니다:

- "트리거 단어를 @Bob으로 바꿔줘"
- "앞으로는 응답을 더 짧고 직접적으로 하도록 기억해줘"
- "내가 좋은 아침이라고 인사하면 맞춤 인사를 추가해줘"
- "매주 대화 요약을 저장해줘"

또는 안내형 변경을 위해 `/customize`를 실행하세요.

코드베이스가 충분히 작아서 Claude가 안전하게 수정할 수 있습니다.

## 기여하기

**기능을 추가하지 마세요. 스킬을 추가하세요.**

새로운 채널이나 에이전트 프로바이더를 추가하고 싶다면 트렁크에 추가하지 마세요. 새 채널 어댑터는 `channels` 브랜치에, 새 에이전트 프로바이더는 `providers` 브랜치에 들어갑니다. 사용자는 `/add-<name>` 스킬로 자신의 포크에 설치하며, 이 스킬은 관련 모듈을 표준 경로로 복사하고, 등록을 연결하며, 의존성을 고정합니다.

이를 통해 트렁크는 순수한 레지스트리이자 인프라로 유지되고, 모든 포크는 가벼운 상태를 유지합니다. 사용자는 요청한 채널과 프로바이더만 얻고 그 외에는 아무것도 얻지 않습니다.

### RFS (Request for Skills)

저희가 보고 싶은 스킬:

**커뮤니케이션 채널**
- `/add-signal` — Signal을 채널로 추가

## 요구 사항

- macOS 또는 Linux (Windows는 WSL2 경유)
- Node.js 20+ 및 pnpm 10+ (설치 프로그램이 누락 시 둘 다 설치합니다)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) 또는 Docker Engine (Linux)
- `/customize`, `/debug`, 설정 중 오류 복구, 그리고 모든 `/add-<channel>` 스킬을 위한 [Claude Code](https://claude.ai/download)

## 아키텍처

```
메시징 앱 → 호스트 프로세스(라우터) → inbound.db → 컨테이너(Bun, Claude Agent SDK) → outbound.db → 호스트 프로세스(전송) → 메시징 앱
```

하나의 Node 호스트가 세션별 에이전트 컨테이너를 오케스트레이션합니다. 메시지가 도착하면 호스트는 엔티티 모델(사용자 → 메시징 그룹 → 에이전트 그룹 → 세션)을 통해 라우팅하고, 세션의 `inbound.db`에 기록한 뒤 컨테이너를 깨웁니다. 컨테이너 내부의 에이전트 러너는 `inbound.db`를 폴링하고, Claude를 실행하며, 응답을 `outbound.db`에 기록합니다. 호스트는 `outbound.db`를 폴링하여 채널 어댑터를 통해 다시 전송합니다.

세션당 두 개의 SQLite 파일이 있으며 각각 정확히 하나의 작성자만 갖습니다. 교차 마운트 경합이 없고, IPC가 없으며, stdin 파이핑이 없습니다. 채널과 대체 프로바이더는 시작 시 자체 등록됩니다. 트렁크는 레지스트리와 Chat SDK 브리지를 제공하고, 어댑터 자체는 포크별로 스킬을 통해 설치됩니다.

전체 아키텍처 설명은 [docs/architecture.md](docs/architecture.md)를, 3단계 격리 모델은 [docs/isolation-model.md](docs/isolation-model.md)를 참고하세요.

핵심 파일:
- `src/index.ts` — 진입점: DB 초기화, 채널 어댑터, 전송 폴링, 스윕
- `src/router.ts` — 인바운드 라우팅: 메시징 그룹 → 에이전트 그룹 → 세션 → `inbound.db`
- `src/delivery.ts` — `outbound.db` 폴링, 어댑터를 통한 전송, 시스템 액션 처리
- `src/host-sweep.ts` — 60초 스윕: 정체 감지, 예정 메시지 깨우기, 반복 처리
- `src/session-manager.ts` — 세션 확인, `inbound.db` / `outbound.db` 열기
- `src/container-runner.ts` — 에이전트 그룹별 컨테이너 생성, OneCLI 자격 증명 주입
- `src/db/` — 중앙 DB (사용자, 역할, 에이전트 그룹, 메시징 그룹, 연결, 마이그레이션)
- `src/channels/` — 채널 어댑터 인프라 (어댑터는 `/add-<channel>` 스킬로 설치)
- `src/providers/` — 호스트 측 프로바이더 설정 (`claude`는 기본 내장, 그 외는 스킬 경유)
- `container/agent-runner/` — Bun 에이전트 러너: 폴 루프, MCP 도구, 프로바이더 추상화
- `groups/<folder>/` — 에이전트 그룹별 파일시스템 (`CLAUDE.md`, 스킬, 컨테이너 설정)

## FAQ

**왜 Docker인가요?**

Docker는 크로스 플랫폼 지원(macOS, Linux, 그리고 WSL2 경유 Windows)과 성숙한 생태계를 제공합니다. macOS에서는 더 가벼운 네이티브 런타임인 Apple Container도 지원됩니다. 추가 격리를 위해 [Docker Sandboxes](docs/docker-sandboxes.md)는 각 컨테이너를 마이크로 VM 안에서 실행합니다.

**Linux나 Windows에서 실행할 수 있나요?**

네. Docker가 기본 런타임이며 macOS, Linux, Windows(WSL2 경유)에서 작동합니다. `bash oncellclaw.sh`를 실행하기만 하면 됩니다.

**이것은 안전한가요?**

에이전트는 애플리케이션 수준의 권한 검사 뒤가 아니라 컨테이너에서 실행됩니다. 명시적으로 마운트된 디렉터리만 접근할 수 있습니다. 자격 증명은 컨테이너에 들어가지 않습니다. 아웃바운드 API 요청은 [OneCLI의 Agent Vault](https://github.com/onecli/onecli)를 통해 라우팅되며, 프록시 수준에서 인증을 주입하고 속도 제한과 접근 정책을 지원합니다. 여전히 실행하는 것을 검토해야 하지만, 코드베이스가 충분히 작아서 실제로 검토할 수 있습니다. 전체 보안 모델은 [보안 문서](https://docs.nanoclaw.dev/concepts/security)를 참고하세요.

**왜 설정 파일이 없나요?**

설정의 난립을 원하지 않습니다. 모든 사용자는 일반적인 시스템을 설정하는 대신, 코드가 정확히 원하는 대로 동작하도록 NanoClaw를 커스터마이즈해야 합니다. 설정 파일을 선호한다면 Claude에게 추가해 달라고 할 수 있습니다.

**서드파티나 오픈소스 모델을 사용할 수 있나요?**

네. 지원되는 경로는 `/add-opencode`(OpenCode 설정을 통한 OpenRouter, OpenAI, Google, DeepSeek 등) 또는 `/add-ollama-provider`(Ollama를 통한 로컬 오픈 웨이트 모델)입니다. 둘 다 에이전트 그룹별로 설정할 수 있으므로, 같은 설치 내에서 서로 다른 에이전트가 서로 다른 백엔드에서 실행될 수 있습니다.

일회성 실험의 경우, Claude API 호환 엔드포인트라면 `.env`를 통해서도 작동합니다:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**문제를 어떻게 디버깅하나요?**

Claude Code에게 물어보세요. "스케줄러가 왜 실행되지 않지?" "최근 로그에 뭐가 있지?" "이 메시지는 왜 응답을 받지 못했지?" 그것이 NanoClaw의 바탕에 깔린 AI 네이티브 접근 방식입니다.

**설정이 왜 작동하지 않나요?**

어떤 단계가 실패하면 `oncellclaw.sh`는 진단하고 재개하기 위해 Claude Code로 넘깁니다. 그래도 해결되지 않으면 `claude`를 실행한 뒤 `/debug`를 실행하세요. Claude가 다른 사용자에게도 영향을 줄 만한 문제를 발견하면, 관련 설정 단계나 스킬에 대한 PR을 열어주세요.

**NanoClaw를 어떻게 제거하나요?**

```bash
bash oncellclaw.sh --uninstall
```

모든 설치는 체크아웃별 ID로 태깅되므로, 제거 프로그램은 해당 사본에 속한 것만 제거합니다: 백그라운드 서비스, 컨테이너와 이미지, 앱 데이터와 로그, 에이전트 파일, 그리고 이 사본의 OneCLI 볼트 에이전트입니다. 공유되는 것 — OneCLI 앱과 여러분의 자격 증명, 머신의 다른 NanoClaw 사본 — 은 그대로 둡니다. 무엇을 발견했는지 정확히 보여주고 그룹별로 확인을 요청합니다. 여러분이 동의하기 전까지는 아무것도 삭제되지 않습니다. 변경 없이 미리 보려면 `--dry-run`을, 프롬프트를 건너뛰려면 `--yes`를 사용하세요. `.env`는 제거 전에 백업됩니다. 마무리하려면 체크아웃 폴더 자체를 삭제하세요.

**어떤 변경이 코드베이스에 받아들여지나요?**

기본 구성에는 보안 수정, 버그 수정, 명확한 개선만 받아들여집니다. 그게 전부입니다.

그 외의 모든 것(새로운 기능, OS 호환성, 하드웨어 지원, 향상)은 스킬로 기여해야 합니다. 채널과 프로바이더 코드는 `channels`/`providers` 레지스트리 브랜치에, 그 외에는 자체 완결형 스킬로 기여합니다. [docs/customizing.md](docs/customizing.md)와 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

이를 통해 기본 시스템을 최소한으로 유지하고, 모든 사용자가 원하지 않는 기능을 떠안지 않으면서 자신의 설치를 커스터마이즈할 수 있습니다.

## 커뮤니티

질문이 있나요? 아이디어가 있나요? [Discord에 참여하세요](https://discord.gg/VDdww8qS42).

## 변경 이력

호환성을 깨는 변경 사항은 [CHANGELOG.md](CHANGELOG.md)를, 또는 문서 사이트의 [전체 릴리스 히스토리](https://docs.nanoclaw.dev/changelog)를 참고하세요.

## 라이선스

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
