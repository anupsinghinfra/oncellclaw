> **oncellclaw** — これは [NanoClaw](https://github.com/nanocoai/nanoclaw) のフォークで、エージェントを Docker ではなく [OnCell](https://oncell.ai) セルで実行します。詳細は英語版 [README](README.md) を参照してください。

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  エージェントを専用コンテナで安全に実行するAIアシスタント。軽量で、理解しやすく、あなたのニーズに完全にカスタマイズできるように設計されています。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">ドキュメント</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ko.md">한국어</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## NanoClawを作った理由

[OpenClaw](https://github.com/openclaw/openclaw)は素晴らしいプロジェクトですが、自分が理解しきれない複雑なソフトウェアに生活へのフルアクセスを与えたまま安心して眠れるとは思えませんでした。OpenClawは約50万行のコード、53の設定ファイル、70以上の依存関係を持っています。セキュリティはアプリケーションレベル（許可リスト、ペアリングコード）であり、真のOSレベルの分離ではありません。すべてが共有メモリを持つ1つのNodeプロセスで動作します。

NanoClawは同じコア機能を提供しますが、理解できる規模のコードベースで実現しています。1つのプロセスと少数のファイル。Claudeエージェントは単なるパーミッションチェックの背後ではなく、ファイルシステム分離された独自のLinuxコンテナで実行されます。

## クイックスタート

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash oncellclaw.sh
```

`oncellclaw.sh`は、まっさらなマシンから、メッセージを送れる名前付きエージェントが動く状態までを一気通貫で案内します。NodeやpnpmやDockerが無ければインストールし、AnthropicクレデンシャルをOneCLIに登録し、エージェントコンテナをビルドし、最初のチャネル（Telegram、Discord、WhatsApp、またはローカルCLI）とペアリングします。途中でステップが失敗すれば自動的にClaude Codeが呼び出され、原因を診断して中断箇所から再開します。

## 設計思想

**理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。NanoClawのコードベース全体を把握したいなら、Claude Codeに説明を求めれば十分です。

**分離によるセキュリティ。** エージェントはLinuxコンテナで実行され、明示的にマウントされたものだけが見えます。コマンドはホストではなくコンテナ内で実行されるため、Bashアクセスも安全です。

**個人ユーザー向け。** NanoClawはモノリシックなフレームワークではなく、各ユーザーのニーズに正確にフィットするソフトウェアです。肥大化するのではなく、オーダーメイドであるよう設計されています。自分のフォークを作り、Claude Codeにニーズに合わせて変更させます。

**カスタマイズ＝コード変更。** 設定の肥大化はありません。動作を変えたいならコードを変える。コードベースは変更しても安全な規模です。

**AIネイティブ、設計としてハイブリッド。** インストールとオンボーディングは最適化されたスクリプトのパスで、速く決定的です。判断が必要なところ（インストール失敗、対話的な決定、カスタマイズ）では、制御はシームレスにClaude Codeへ渡されます。セットアップ以降も、監視ダッシュボードやデバッグUIは用意しません。問題をチャットで説明すれば、Claude Codeが処理します。

**機能ではなくスキル。** トランクにはレジストリとインフラのみを同梱し、個別のチャネルアダプターや代替プロバイダーは含めません。チャネル（Discord、Slack、Telegram、WhatsAppなど）は長期運用される`channels`ブランチに、代替プロバイダー（OpenCode、Ollama）は`providers`ブランチに置かれます。`/add-telegram`や`/add-opencode`などを実行すると、スキルが必要なモジュールだけを正確にフォークへコピーします。要求していない機能は一切入りません。

**最高のハーネス、最高のモデル。** NanoClawはAnthropic公式のClaude Agent SDK経由でネイティブにClaude Codeを使用します。最新のClaudeモデルとClaude Codeの全ツールセット（自分のNanoClawフォークを変更・拡張する能力を含む）が手に入ります。他プロバイダーはドロップイン・オプションです。OpenAIのCodex（ChatGPTサブスクリプションまたはAPIキー）向けには`/add-codex`、OpenCode経由のOpenRouter、Google、DeepSeekなどには`/add-opencode`、ローカルのオープンウェイトモデルには`/add-ollama-provider`。プロバイダーはエージェントグループごとに設定可能です。

## できること

ここに挙げた項目はすべて実際に出荷されているコードです — リンクを辿って読んでみてください。エージェント側の機能は[`container/skills/`](container/skills/)と[`container/agent-runner/src/mcp-tools/`](container/agent-runner/src/mcp-tools/)に、インストール時の機能は[`.claude/skills/`](.claude/skills/)のスラッシュコマンドにあります。

**どこからでも話しかけられる**

- **Webチャットを標準搭載** — メッセージを`POST`し、双方向トランスクリプト全体をポーリングするか、Server-Sent-Eventsストリームを開いたままにできます。ベアラートークン認証とレート制限も込み。ブラウザやダッシュボードだけで完全なクライアントになります。([`src/channels/web.ts`](src/channels/web.ts))
- **Telegramはワンペースト** — @BotFatherでボットを作成し、`POST /web/channels/telegram/pair`するだけ。ロングポーリングなのでNATの内側でも、webhookを持たないホステッドセルでも同じように動きます。([`src/channels/telegram.ts`](src/channels/telegram.ts))
- **さらに十数チャネルをスキルで** — WhatsApp、Discord、Slack、iMessage、Teams、Matrix、Google Chat、Webex、Signal、WeChat、Linear、GitHub、Resend経由のメール。`/add-<channel>`が要求したアダプターだけを正確にあなたのフォークへコピーします。([`.claude/skills/`](.claude/skills/))
- **アシスタントは1つでも複数でも** — プライバシーのためにチャネルごとに専用エージェントを配線する、メモリを統一するために1つのエージェントを複数チャネルで共有する、あるいは複数チャネルを1つの会話に畳み込む。`/manage-channels`でチャネル単位に選択できます。([docs/isolation-model.md](docs/isolation-model.md))

**アシスタントができること**

- **Webをブラウズする** — リサーチ、フォーム入力、スクリーンショット、データ抽出、実ブラウザでのWebアプリのテスト。([`container/skills/agent-browser`](container/skills/agent-browser/SKILL.md))
- **自分の仕事を自分でスケジュールする** — 単発とcron定期のタスクを、それぞれ独立したセッションと実行ログ付きで。オプションの[スクリプトゲート](docs/scheduled-tasks.md)が新しい仕事の有無を安価にチェックし、仕事があるときだけエージェントを起こします。([`src/modules/scheduling/`](src/modules/scheduling/))
- **チームメイトを生み出す** — `create_agent`が独自のワークスペースを持つ長寿命エージェントを誕生させ、双方向に配線します。委任し、メッセージを受け取る。配線済みのペア同士ならエージェント間メッセージングが機能します。([`mcp-tools/agents.ts`](container/agent-runner/src/mcp-tools/agents.ts)、[`src/modules/agent-to-agent/`](src/modules/agent-to-agent/))
- **行動する前に確認を取る** — 特権的な操作（パッケージのインストール、MCPサーバーの追加、エージェントの作成）は管理者への承認カードを経由します。ガードはエージェントの善意ではなく配信パス側に存在します。([`src/modules/approvals/`](src/modules/approvals/)、[`src/delivery-guard.ts`](src/delivery-guard.ts))
- **きちんと質問する** — ブロッキングの多肢選択質問と、対応チャネルではリッチカード。([`mcp-tools/interactive.ts`](container/agent-runner/src/mcp-tools/interactive.ts))
- **本物の成果物を送る** — ファイル、チャート、PDFをチャットへ。自分が送ったメッセージの編集も、あなたのメッセージへのリアクションもできます。([`mcp-tools/core.ts`](container/agent-runner/src/mcp-tools/core.ts))
- **自分自身を拡張する** — apt/npmパッケージのインストール、MCPサーバーの追加、自身の指示やコードの編集（承認ゲート付き）。大きな変更にはビルダーエージェントパターンを使います。([`container/skills/self-customize`](container/skills/self-customize/SKILL.md)、[`mcp-tools/self-mod.ts`](container/agent-runner/src/mcp-tools/self-mod.ts))
- **本気でWebソフトウェアを作る** — フロントエンドエンジニアリングの規律スキルが「完成」の前に実ブラウザでのビルド・テスト・検証を強制し、`/add-vercel`のようなデプロイスキルと組み合わせられます。([`container/skills/frontend-engineer`](container/skills/frontend-engineer/SKILL.md))
- **記憶する** — エージェントごとの`CLAUDE.md`常設指示に加えて、あらゆる再起動を生き延びる構造化・予算管理されたメモリインデックスを、セッションごとに新しく合成します。([`src/claude-md-compose.ts`](src/claude-md-compose.ts)、[`container/agent-runner/src/memory/`](container/agent-runner/src/memory/))
- **自分のインストールを自分で管理する** — コンテナ内の`ncl` CLIがチャネル、配線、タスク、セッションを照会し、（権限ゲート付きで）変更します。([`src/cli/`](src/cli/))

**内部の仕組み**

- **ラップトップより長生きする** — OnCellランタイムでは、各エージェントの世界全体（メモリ、ファイル、`CLAUDE.md`）が永続的なgVisorセルに存在します。ラップトップが死んでもアシスタントは死にません。アイドルのセルは~$0でストレージに一時停止し、次のメッセージで起きます。([`src/cell-runner.ts`](src/cell-runner.ts))
- **スナップショットとフォーク** — セルのファイルシステムはOnCell APIでチェックポイントもクローンも可能：アシスタントのバックアップも、状態まるごとのフォークもできます。
- **完全ローカルという選択肢** — `ONCELL_API_KEY`が無ければ、すべてが上流のNanoClawとまったく同じようにローカルのDockerコンテナで動きます。([`src/container-runner.ts`](src/container-runner.ts))
- **クレデンシャル・ボールト** — [OneCLIゲートウェイ](https://github.com/onecli/onecli)があれば、エージェントは生のAPIキーを一切保持しません。クレデンシャルはリクエスト時にエージェントごとのポリシー付きで注入され、dockerインストールでは全egressをゲートウェイ経由にハードロックできます。([`src/egress-lockdown.ts`](src/egress-lockdown.ts)、[`src/cell-gateway.ts`](src/cell-gateway.ts))
- **構造からしてサンドボックス** — すべてのエージェントは自分専用のコンテナまたはセルで動き、あなたが許可リストに入れたマウントだけが見えます。([`src/modules/mount-security/`](src/modules/mount-security/))
- **ユーザー、ロール、未知の送信者** — ユーザーごとにowner/admin/memberロール。見知らぬ人があなたのボットにメッセージを送ると、会話ではなく承認カードが発火します。([`src/modules/permissions/`](src/modules/permissions/))
- **エージェントテンプレート** — `ncl groups create --template <ref>`で、すぐ動くエージェント（指示＋ツール＋スキル、シークレットなし）をスタンプできます。([docs/templates.md](docs/templates.md))
- **エージェントごとのモデル選択** — Claude Codeはネイティブ。`/add-codex`、`/add-opencode`（OpenRouter、Google、DeepSeek…）、ローカルのオープンウェイトモデルには`/add-ollama-provider`。([`.claude/skills/`](.claude/skills/))

## ホステッド版の仕組み

ホステッド版に別のコードベースはありません。ホステッドインスタンスとは、*この*リポジトリがあなた自身のOnCellセル内のサービスとして動いているものです。起動するのは[`scripts/cloud-start.sh`](scripts/cloud-start.sh) — [oncell.ai/dashboard/claw](https://oncell.ai/claw)があなたの代わりに実行するのと同じスクリプトで、インターネットに繋がる任意のマシンで自分で実行することもできます。ブートストラップは**nodeのみ**で完結します：セルにはnode、npm/corepack、tarはありますが**git、curl、wget、python3はありません**。そのためソースはnodeが取得するGitHubのtarballとして届き（`ONCELLCLAW_REF`をGitHub APIでコミットshaに解決し、`codeload.github.com/{owner}/{repo}/tar.gz/{sha}`のtarballをダウンロードして展開）、pnpmはcorepackのshimから来て、スクリプト内のすべてのダウンロードは`node fetch`を通ります。1つのコマンドが空のマシンを生きたアシスタントまで運びます：ソースの取得と展開、ツールチェーンのプロビジョニング、インストール、ビルド、組み込みの[`web`チャネル](src/channels/web.ts)にペアリングされたエージェントグループのプロビジョニング、そして最後にホストを`exec`してスーパーバイザーがプロセスを所有します。

ベースディレクトリ（`ONCELLCLAW_DIR`、デフォルト`~/oncellclaw`）は不変のソースと永続的な状態を分離するので、アップデートがアシスタントの記憶を破壊することは決してありません：

```
current -> src-<sha>   実行中のチェックアウト（シンボリックリンク、原子的に切替）
src-<sha>/             1コミット分の不変ソースツリー
state/                 data/ groups/ store/ .env — すべてのチェックアウトへ
                       シンボリックリンクされ、どのアップデートでも生き残る
toolchain/             corepackのshim（＋システムのnodeが古い場合は専用node）
```

すべてのステージは冪等なので、再起動しても重複せず収束します：すでに展開済みのshaなら一切ダウンロードは発生せず（フルshaに固定されたウォームリスタートは完全オフラインで起動）、新しいshaは並行して展開されてから`current`が切り替わり、古いツリーは新しいものがビルドとプロビジョニングを終えた後にのみ削除されます — 失敗したアップデートが最後の正常なチェックアウトを消すことはありません。プロビジョニングは既に作成済みのエージェントグループを見つけて再利用し、2つ目を作りません。`ONCELLCLAW_RUNTIME=oncell`ではホスト自身のエージェントグループは同じアカウント配下の兄弟セルに住み、ホストセルは薄いルーターのままです。`web`チャネルは会話全体をプロセスの単一HTTPポート（`$PORT`）に載せ、それがセルの公開プレビューURLにマッピングされます：

```bash
# 話しかける
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"hello"}' https://<host>/web/assistant/message          # → 202 {"ok":true,"id":"web-…"}
# 返信をポーリング（次回は`cursor`を`after`として返す）
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/messages?after='                      # → 200 {"messages":[…],"cursor":"…"}
# 双方向の会話全体（ユーザー行＋アシスタント行、順序付き、再開可能）
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/transcript?after='                    # → 200 {"messages":[{direction,…}],"cursor":"…"}
# ポーリングの代わりにプッシュ：Server-Sent Events、1行につき1つの`event: message`
curl -N -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     'https://<host>/web/assistant/stream'                               # リプレイ後、ライブでストリーム
curl https://<host>/web/health                                           # → 200 {"ok":true,"groups":[…]}
# ダッシュボード用イントロスペクション（トークン認証）：version、groups（実行コスト込み）、channels、skills
curl -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" \
     https://<host>/web/status                                           # → 200 {"version":…,"channels":[…],…}
```

**実行コスト：** 各エージェントターンのコストとトークン使用量（Claude Codeの報告値）はセッションごとにセッションDBへ累積されます。`/web/status`はグループ単位で台帳を合算し — `groups[].cost`は`{ costUsd, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns }`、最初のターンが記録されるまでは`null` — 各アシスタント行のトランスクリプトにはそのターン自身の`costUsd`が載るので、ダッシュボードは返信ごとの控えめな注記を表示できます。

**初回起動：** スクリプトは何かをダウンロードする前に、まず`$PORT`を小さなプレースホルダーサーバーで即座にバインドします。サービススーパーバイザー（OnCellのセルスーパーバイザーを含む）は数秒以内に接続を受け付けないサービスを殺しますが、コールドインストールには数分かかるからです。ブートストラップの間、（`/web/health`を含む）**すべての**パスは`503`で`{"ok":false,"phase":"…"}`を返し、`phase`は`starting → clone → toolchain → install → build → provision → handoff`と進みます。プレースホルダーが本物のホストにポートを渡す短い接続拒否の隙間の後、`/web/health`が`200 {"ok":true,…}`を返します — `ok`がtrueになるまでポーリングすれば、アシスタントが生きたと分かります。ウォームリスタートはダウンロードとインストールを飛ばし、数秒でハンドオフします。

セルにはcurlが無いので、スクリプトを取得して実行するサービスコマンド自体もnodeのみです：

```sh
node -e 'const fs=require("fs");const repo=process.env.ONCELLCLAW_REPO||"https://github.com/anupsinghinfra/oncellclaw.git";const ref=process.env.ONCELLCLAW_REF||"main";const m=repo.match(/github\.com[:\/]([^\/]+)\/([^\/]+?)(?:\.git)?$/);if(!m){console.error("cannot parse ONCELLCLAW_REPO: "+repo);process.exit(1)}const url="https://raw.githubusercontent.com/"+m[1]+"/"+m[2]+"/"+ref+"/scripts/cloud-start.sh";fetch(url,{headers:{"User-Agent":"oncellclaw-bootstrap"}}).then(async r=>{if(!r.ok){console.error("HTTP "+r.status+" for "+url);process.exit(1)}const t=await r.text();if(!t.includes("cloud-start.sh")){console.error("unexpected script body from "+url);process.exit(1)}fs.writeFileSync("/tmp/cloud-start.sh",t);console.log("fetched "+url)}).catch(e=>{console.error("fetch failed: "+e);process.exit(1)})' && bash /tmp/cloud-start.sh
```

このURLは公開されているので、インターネットとあなたのアシスタントの間にあるのは`ONCELLCLAW_WEB_TOKEN`だけです：信頼できるローカルネットワーク向けに明示的に`ONCELLCLAW_WEB_ALLOW_INSECURE=1`を設定しない限り、チャネルはトークン無しでは起動を拒否します。ここでシークレットがディスクに書かれることはありません — クレデンシャルはプロセス環境の中だけを移動します。チャネルは自らレート制限も行います：認証失敗はクライアントIPごとに上限（デフォルト20回/分、トークン比較の*前*にチェックされるので、漏れたURLへのブルートフォースは壁に当たります）、メッセージ`POST`はグループごとに上限（デフォルト30回/分、バースト対応のトークンバケット）。予算超過のリクエストは`Retry-After`ヘッダー付きの`429 {"error":"rate_limited"}`を受け取ります。`GET`ポーリングと`/health`は決して制限されません。

| 変数 | デフォルト | 意味 |
|---|---|---|
| `ONCELLCLAW_WEB_TOKEN` | — | すべての`/web/…`リクエストのベアラートークン。insecureフラグを設定しない限り**必須**。`openssl rand -hex 32`で生成。 |
| `ONCELLCLAW_WEB_ALLOW_INSECURE` | 未設定 | `1`で`web`チャネルを認証なしで実行。ローカル開発専用。 |
| `ONCELLCLAW_WEB_AUTH_FAILURES_PER_MIN` | `20` | 1つのクライアントIPが1分間に許される認証失敗回数。超えると`/web/…`は`429`（スライディングウィンドウ、トークン比較の前に参照）。 |
| `ONCELLCLAW_WEB_MESSAGES_PER_MIN` | `30` | 1グループが1分間に受け付けるメッセージ`POST`数（トークンバケット、同数までバースト可）。`GET`ポーリングと`/health`は無制限。 |
| `PORT` | `3000` | HTTPリッスンポート。ホステッド実行ではセルスーパーバイザーが常に設定 — フォールバックは素の自己ホスティング専用。`WEBHOOK_PORT`が引き続き優先。 |
| `ONCELLCLAW_GROUP` | `assistant` | プロビジョニングするエージェントグループ。URLスラッグも兼ねる：`/web/<group>/message`。 |
| `ONCELLCLAW_PERSONA` | — | そのグループの常設指示。ペルソナとして一度だけステージされ、編集済みのものを上書きしない。 |
| `ONCELLCLAW_REPO` | このリポジトリ | 実行するGitHubリポジトリURL（tarballブートストラップ — `github.com`必須）。 |
| `ONCELLCLAW_REF` | `main` | ブランチ、タグ、またはコミットsha。40桁フルshaならref解決を飛ばし、オフラインでウォームリスタート。 |
| `ONCELLCLAW_DIR` | `$HOME/oncellclaw` | 永続ベース：`src-<sha>/`チェックアウト、`current`シンボリックリンク、`state/`（`data`、`groups`、`store`、`.env`）、`toolchain/`。状態はすべてのアップデートを生き残る。 |
| `ONCELLCLAW_RUNTIME` | `oncell` | `oncell`または`docker`（[README（英語）のRuntimes](README.md#runtimes-oncell-cells-or-local-docker)参照）。 |
| `ONCELLCLAW_CELL_NAMESPACE` | インストールスラッグ | このインスタンスのエージェントグループセル（`clawg-{namespace}-{group}`）を同じOnCellアカウント内の他のclawから分離。ケバブケース、24文字以下。ホステッドではダッシュボードがインスタンスごとに一意な値を設定。自己ホストならデフォルト（チェックアウトパスのsha1）で十分。 |
| `ONCELL_API_KEY` | — | ランタイムが`oncell`のとき必須。 |
| `ONCELL_API_URL` | — | 任意のAPIエンドポイント上書き。 |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | — | エージェントのクレデンシャル。どちらか一方が必須。 |

`web`チャネルはホステッド専用ではありません — `cli`と同じようにmainに同梱されているので、自己ホスティングでもブラウザ、スクリプト、自作フロントエンドを同じ3つのエンドポイントでローカルのoncellclawに向けられます。[config-examples/hosted.env.example](config-examples/hosted.env.example)を参照してください。

### Telegramを接続する

mainには依存関係ゼロのTelegramアダプターが同梱されており、**ロングポーリング**モードで動きます — 公開webhookが不要なので、ホステッドセルでもNATの内側のラップトップでも同一に動作します。[@BotFather](https://t.me/BotFather)でボットを作成し（`/newbot`、表示されたトークンをコピー）、次のいずれかを実行します：

- **ダッシュボード**：Connections & Integrations → Telegram → Connect → トークンを貼り付け。パネルは下記APIの薄いクライアントです。
- **API/curl**：

```bash
curl -X POST -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" -H 'Content-Type: application/json' \
     -d '{"botToken":"<BotFatherのトークン>"}' https://<host>/web/channels/telegram/pair
# → 200 {"ok":true,"bot":{"username":"YourBot"}}      ペアリング完了。アダプターは即座に稼働
# → 400 {"error":"invalid_token"}                     形式不正、またはTelegramが拒否
# → 502 {"error":"telegram_unreachable"}              ホストからTelegram APIに到達できない
curl -X DELETE -H "Authorization: Bearer $ONCELLCLAW_WEB_TOKEN" https://<host>/web/channels/telegram
# → 200 {"ok":true}                                   アダプター停止、クレデンシャル削除
```

ペアリングはトークンを`getMe`で検証し、インストールの`.env`に`TELEGRAM_BOT_TOKEN`として保存し（CLIセットアップパスが書くのと同じ場所 — どの方法でペアリングしても1つのクレデンシャルストア）、再起動なしでアダプターを起動します。`/web/status`は即座にそれを反映し（`configured:true, connected:true, detail:"@YourBot"`）、サポートするチャネル一式（`web`、`cli`、`telegram`、`whatsapp`、`discord`、`imessage`）を常に正直な状態で列挙するので、ダッシュボードはすべてのConnectボタンを掛ける行を持てます。Telegramであなたのボットにメッセージを送れば、アシスタントがそこで答えます。未承認の送信者からのDMは、通常の未知送信者承認フローを通ります。

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントに話しかけます：

```
@Andy 毎朝9時に営業パイプラインの概要を送って（Obsidian vaultフォルダにアクセス可能）
@Andy 毎週金曜に過去1週間のgit履歴をレビューして、差異があればREADMEを更新して
@Andy 毎週月曜の朝8時に、Hacker NewsとTechCrunchからAI関連のニュースをまとめてブリーフィングを送って
```

所有または管理しているチャネルからは、グループやタスクを管理できます：
```
@Andy 全グループのスケジュールタスクを一覧表示して
@Andy 月曜のブリーフィングタスクを一時停止して
@Andy Family Chatグループに参加して
```

## カスタマイズ

NanoClawは設定ファイルを使いません。変更したいときは、Claude Codeにやりたいことを伝えるだけです：

- 「トリガーワードを@Bobに変更して」
- 「今後はレスポンスをもっと短く直接的にして」
- 「おはようと言ったらカスタム挨拶を追加して」
- 「会話の要約を毎週保存して」

または`/customize`を実行すればガイド付きで変更できます。

コードベースは十分に小さいため、Claudeが安全に変更できます。

## コントリビューション

**機能を追加するのではなく、スキルを追加してください。**

新しいチャネルやエージェントプロバイダーを追加したい場合、トランクには追加しないでください。新しいチャネルアダプターは`channels`ブランチに、新しいエージェントプロバイダーは`providers`ブランチに追加します。ユーザーはそれぞれのフォークで`/add-<name>`スキルを実行し、スキルが必要なモジュールを標準パスへコピーし、登録を配線し、依存関係をピン留めします。

こうすることでトランクは純粋なレジストリ／インフラのまま保たれ、どのフォークもスリムなままです。ユーザーは求めたチャネルとプロバイダーだけを受け取り、それ以外は入りません。

### RFS（スキル募集）

私たちが見たいスキル：

**コミュニケーションチャネル**
- `/add-signal` — Signalをチャネルとして追加

## 必要条件

- macOSまたはLinux（WindowsはWSL2経由）
- Node.js 20以上とpnpm 10以上（インストーラーが未インストールなら両方をインストールします）
- [Docker Desktop](https://docker.com/products/docker-desktop)（macOS/Windows）または Docker Engine（Linux）
- [Claude Code](https://claude.ai/download)（`/customize`、`/debug`、セットアップ時のエラー復旧、全ての`/add-<channel>`スキルで使用）

## アーキテクチャ

```
メッセージングアプリ → ホストプロセス（ルーター） → inbound.db → コンテナ（Bun、Claude Agent SDK） → outbound.db → ホストプロセス（配信） → メッセージングアプリ
```

単一のNodeホストがセッションごとのエージェントコンテナをオーケストレーションします。メッセージが到着すると、ホストはエンティティモデル（ユーザー → メッセージンググループ → エージェントグループ → セッション）に沿ってルーティングし、セッションの`inbound.db`に書き込み、コンテナを起こします。コンテナ内部のagent-runnerは`inbound.db`をポーリングしてClaudeを実行し、レスポンスを`outbound.db`に書き込みます。ホストは`outbound.db`をポーリングし、チャネルアダプターを通じて配信します。

セッションごとに2つのSQLiteファイル、各ファイルにライターは1つだけ — クロスマウントの競合なし、IPCなし、stdinパイプなし。チャネルと代替プロバイダーは起動時に自己登録します。トランクはレジストリとChat SDKブリッジを同梱し、アダプター本体はフォークごとにスキルでインストールされます。

詳しいアーキテクチャ説明は[docs/architecture.md](docs/architecture.md)を、3階層の分離モデルについては[docs/isolation-model.md](docs/isolation-model.md)を参照してください。

主要ファイル：
- `src/index.ts` — エントリーポイント：DB初期化、チャネルアダプター、配信ポーリング、sweep
- `src/router.ts` — インバウンドルーティング：メッセージンググループ → エージェントグループ → セッション → `inbound.db`
- `src/delivery.ts` — `outbound.db`をポーリングし、アダプター経由で配信、システムアクションを処理
- `src/host-sweep.ts` — 60秒ごとのsweep：ストール検出、期限到来メッセージの起動、繰り返し
- `src/session-manager.ts` — セッションの解決、`inbound.db`と`outbound.db`のオープン
- `src/container-runner.ts` — エージェントグループごとのコンテナ起動、OneCLIによるクレデンシャル注入
- `src/db/` — セントラルDB（ユーザー、ロール、エージェントグループ、メッセージンググループ、配線、マイグレーション）
- `src/channels/` — チャネルアダプターのインフラ（アダプターは`/add-<channel>`スキルでインストール）
- `src/providers/` — ホスト側プロバイダー設定（`claude`はバンドル、その他はスキル経由）
- `container/agent-runner/` — Bun製agent-runner：ポーリングループ、MCPツール、プロバイダー抽象化
- `groups/<folder>/` — エージェントグループごとのファイルシステム（`CLAUDE.md`、スキル、コンテナ設定）

## FAQ

**なぜDockerなのか？**

Dockerはクロスプラットフォーム対応（macOS、Linux、WSL2経由のWindows）と成熟したエコシステムを提供します。macOSでは、`/convert-to-apple-container`でオプションとしてApple Containerに切り替え、より軽量なネイティブランタイムを使えます。さらに強い分離が必要なら、[Docker Sandboxes](docs/docker-sandboxes.md)が各コンテナをマイクロVM内で動作させます。

**LinuxやWindowsで実行できますか？**

はい。Dockerがデフォルトのランタイムで、macOS、Linux、Windows（WSL2経由）で動作します。`bash oncellclaw.sh`を実行するだけです。

**セキュリティは大丈夫ですか？**

エージェントはアプリケーションレベルのパーミッションチェックではなく、コンテナ内で実行されます。明示的にマウントされたディレクトリのみアクセス可能です。クレデンシャルはコンテナに渡されず、アウトバウンドAPIリクエストは[OneCLI Agent Vault](https://github.com/onecli/onecli)を経由し、プロキシレベルで認証を注入し、レートリミットやアクセスポリシーをサポートします。実行するものはレビューすべきですが、コードベースは実際にレビュー可能な規模です。完全なセキュリティモデルについては[セキュリティドキュメント](https://docs.nanoclaw.dev/concepts/security)を参照してください。

**なぜ設定ファイルがないのか？**

設定の肥大化を避けたいからです。すべてのユーザーがNanoClawをカスタマイズし、汎用的なシステムを設定するのではなくコードが自分の望み通りに動くようにすべきです。設定ファイルが欲しければClaudeに追加するよう伝えれば実現できます。

**サードパーティやオープンソースモデルを使えますか？**

はい。推奨される方法は`/add-opencode`（OpenCode設定経由でOpenRouter、OpenAI、Google、DeepSeekなど）か`/add-ollama-provider`（Ollama経由でローカルのオープンウェイトモデル）です。どちらもエージェントグループごとに設定可能なので、同じインストール内で異なるエージェントが異なるバックエンドで動作できます。

一時的な実験用には、Claude API互換のエンドポイントも`.env`で利用できます：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**問題のデバッグ方法は？**

Claude Codeに聞いてください。「スケジューラーが動いていないのはなぜ？」「最近のログには何がある？」「このメッセージに返信がなかったのはなぜ？」これがNanoClawの基盤となるAIネイティブなアプローチです。

**セットアップがうまくいかない場合は？**

ステップが失敗した場合、`oncellclaw.sh`は診断と再開のためにClaude Codeへ制御を渡します。それでも解決しなければ、`claude`を実行して`/debug`を呼び出してください。他のユーザーにも影響しそうな問題をClaudeが特定した場合は、該当のセットアップステップまたはスキルにPRを送ってください。

**どのような変更がコードベースに受け入れられますか？**

ベース設定に受け入れられるのは、セキュリティ修正、バグ修正、明確な改善のみです。それだけです。

それ以外（新機能、OS互換性、ハードウェアサポート、拡張など）は、`channels`または`providers`ブランチのスキルとしてコントリビュートしてください。

これにより、ベースシステムを最小限に保ち、全ユーザーが不要な機能を継承することなく自分のインストールをカスタマイズできます。

## コミュニティ

質問やアイデアがありますか？[Discordに参加](https://discord.gg/VDdww8qS42)してください。

## 変更履歴

破壊的変更については[CHANGELOG.md](CHANGELOG.md)を、完全なリリース履歴はドキュメントサイトの[full release history](https://docs.nanoclaw.dev/changelog)を参照してください。

## ライセンス

MIT
