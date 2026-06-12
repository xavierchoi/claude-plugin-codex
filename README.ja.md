# claude-plugin-codex

Codex の中から Claude Code に相談できます。

[English](./README.md) | [한국어](./README.ko.md) | **日本語** | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

[![tests](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml/badge.svg)](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

このプラグインは、いつものワークフローのまま Claude Code の力を借りたい
Codex ユーザーのためのものです。やってほしいことを普段の言葉で伝えるだけで、
Claude が同じリポジトリ内で — すでにログイン済みの Claude アカウントを使って —
実行され、丁寧なセカンドオピニオンを返してくれます。

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) が同じ
2 つのツールを逆方向につなぐのに対し、このプラグインはその対になる存在です。
両方のエージェントを使っているなら、2 つのプラグインで円が完成します。

```text
you   ▸ have claude redesign the landing page and make sure it still builds

codex ▸ claude-code.consult(prompt=…, edit=true, background=true, verify="auto")
        Started background consult job job-a1b2c3.

codex ▸ 🤝 Claude Code made changes in ~/projects/site.
        Redesigned src/app/page.tsx with a bolder hero and …
        Files Claude touched:
        - src/app/page.tsx
        🔍 Verification: `node --check 'src/app/page.tsx'` → ✅ exit 0
        ( 14 turns · 3m41s · ≈$0.42 of plan usage )
```

## 提供されるもの

`claude-code` MCP サーバー（Node 製、依存関係ゼロ）と 6 つのツール:

- `consult` — Claude Code にタスクを依頼します。デフォルトは助言のみです
- `review` — 未コミットの変更やブランチへの丁寧な読み取り専用レビュー
- `consult_status` / `consult_result` / `consult_cancel` — バックグラウンドジョブの管理
- `setup` — Claude Code のインストールとログイン状態の確認

これらを直接呼び出す必要はありません。同梱のスキルが、ユーザーの言葉から
適切なツールとオプション（`edit`、`background`、`verify`、`resume`）を
Codex 自身が選べるように導きます。

## 必要なもの

- **Claude Code**（インストールとログイン）:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude   # 一度起動してログイン
  ```

  consult は既存の Claude ログインをそのまま使うため、使用量は Claude の
  プランから消費され、別途の請求はありません。透明性のため、結果には
  `≈$0.42 of plan usage` のような目安が表示されます。（`ANTHROPIC_API_KEY`
  を明示的に設定した場合のみ API 課金となり、その旨が表示されます。）

- **Node.js 20+**
- プラグイン対応の **Codex**、Linux または macOS。

## インストール

```bash
codex plugin marketplace add xavierchoi/claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

その後、Codex に *「Claude の準備はできてる？」* と聞いてみてください —
`setup` ツールが実行され、直すべきことがあれば正確なコマンド付きで教えて
くれます。

## 使い方

### セカンドオピニオンを求める

```text
この変更について Claude の意見を聞いて。
このクエリが遅い理由を Claude に調べてもらって。
```

デフォルトでは Claude は plan mode で動きます: ファイルには触れず、調査と
助言だけを行います。

### レビューを頼む

```text
Claude に私の変更をレビューしてもらって。
このブランチを main と比べて Claude にレビューしてもらって — リトライ処理を中心に。
```

サーバーが git diff を自分で収集し（未コミットの変更、または base ブランチ
以降のすべて）、Claude が読み取り専用でレビューします: 短い要約、良い点、
重要度順の指摘（file:line 付き）、そして率直な総評。

### Claude に修正を任せる

```text
Claude にデータレイヤーを整理してもらって、コンパイルが通るかも確認して。
```

変更を頼むと Codex が `edit: true` を設定し、コード修正には `verify: "auto"`
を併用します — Claude の作業後、サーバーが変更されたファイルに簡単な構文
チェックを実行し、その結果を回答に添えます。

### 時間のかかるタスク

```text
Claude にダッシュボードのリデザインを任せて — 時間がかかっても大丈夫。
```

軽い作業を超えるものはバックグラウンドジョブとして実行されます。Codex が
ジョブ id を伝え、効率よく待機し（`consult_status` はロングポーリング対応）、
完了したら結果を提示します。途中で状態を聞いたりキャンセルしたりでき、
すべての実行はライブログを残します:

```bash
tail -f ~/.cache/cc-plugin-codex/logs/latest.log
```

> [!NOTE]
> フォアグラウンドの consult は UI に進捗が表示されず、28 分の上限が
> あります。ある程度の規模の作業ならバックグラウンドが快適です — スキルが
> Codex を自然とそちらへ導きます。

### 続きから作業する

```text
さっきのを Claude に磨いてもらって、テストも直してもらって。
```

セッション id はディレクトリごとに記憶されるため、続きの依頼は同じ Claude
の会話を引き継ぎます。

### 自分の Claude Code スキルを使う

Claude は、ユーザーが Claude Code にインストールしているスキルと一緒に
動きます:

```text
Claude に frontend-design スキルでこのページをリデザインしてもらって。
```

### モデルと effort を選ぶ

```text
Claude にざっと安く見てもらって。                  → effort: low
このレースコンディションは Claude にじっくり考えてもらって。 → effort: high
opus にこの設計をレビューしてもらって。            → model: opus
```

伝えれば Codex がそのまま渡します（`--model` は `sonnet`/`opus` などの
エイリアスまたはフルネーム、`--effort` は `low`…`max`）。伝えなければ、
デフォルトがこの順で適用されます: プラグイン設定 → ユーザー自身の Claude
設定。プラグインレベルのデフォルトは
`~/.config/cc-plugin-codex/settings.json` に追加してください:

```json
{ "model": "sonnet", "effort": "medium" }
```

## verify ポリシー

`verify` コマンドは承認ゲートなしで MCP サーバーから実行されるため、安全の
ためにポリシーで制限されています。デフォルトの `safe` は `"auto"` と、
シェル演算子を含まない著名なビルド/テストツール（npm、pytest、cargo、go、
make など）の単純な呼び出しのみを許可します。設定は
`~/.config/cc-plugin-codex/settings.json` で行います:

```json
{ "verify": "safe" }
```

- `"auto-only"` — `verify: "auto"` のみ許可
- `"safe"` — デフォルト。上記のとおり
- `"all"` — 任意のコマンドを許可。このツールに到達しうるすべてを信頼できる場合のみ

## アップデート

```bash
codex plugin marketplace upgrade claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

## 仕組み

```
Codex ──(MCP: consult)──▶ claude-code MCP サーバー (Node、依存ゼロ)
                               │
                               ├─▶ claude -p  (ヘッドレス、同じリポジトリ、
                               │              既存ログイン、edit でなければ plan mode)
                               ├─▶ 編集後に任意の verify コマンドを実行
                               └─▶ 整形した結果 ──▶ Codex へ返却
```

バックグラウンドジョブはファイルベースの状態を持つ独立（detached）ワーカー
として動きます: 45 分のウォッチドッグ、同時実行数の上限、死んだジョブの
自動整理、プロセスグループ単位のキャンセル — キャンセルや放置された consult
が Claude のプロセスを残すことはありません。

## 開発

```bash
npm test        # 偽の claude バイナリで動くフルスイート — 高速・使用量ゼロ
npm run test:live   # 実際の claude で動くオプトインのスモークテスト
```

## ライセンス

[MIT](./LICENSE)
