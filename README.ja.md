<div align="center">

<img src="docs/banner.png" alt="Swob" width="100%" />

<p>
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="CHANGELOG.md">更新履歴</a>
</p>

<p>
  <img src="https://img.shields.io/badge/バージョン-1.1.1-blue" alt="バージョン" />
  <img src="https://img.shields.io/badge/プラットフォーム-macOS-lightgrey" alt="プラットフォーム" />
  <img src="https://img.shields.io/badge/製作-Electron-47848F" alt="Electron製" />
  <img src="https://img.shields.io/github/downloads/IvyYang1999/swob/total" alt="ダウンロード数" />
  <img src="https://img.shields.io/badge/ライセンス-AGPL--3.0-green" alt="ライセンス" />
</p>

<h3>Claude Code セッションを閲覧・検索・再開</h3>

<p>
  <strong>Claude Code</strong>・<strong>Codex</strong>・<strong>Cursor</strong> のセッションマネージャー。<br/>
  compact された会話を復元。数百のセッションを横断検索。ワンクリックで再開。
</p>

</div>

<br/>

<p align="center">
  <img src="docs/screenshot.png" alt="Swob メイン画面" width="800" />
</p>

---

## 問題

Claude Code で `~` ディレクトリから何ヶ月も vibe-code してきた。200以上のセッションが整理されないまま山積み。半分は compact されて、元の会話は消え、サマリーだけが残っている。内蔵の `/resume` は最近のセッションしか表示しない。あの厄介なバグを解決した会話を見つけたい？幸運を祈る。

## 解決策

Swob は Claude Code・Codex・Cursor がディスクに保存する JSONL ファイルを読み取る。すべてのセッションを解析し、ブランチと続きを検出し、**compact 前の完全な履歴を再構築**して、検索・整理可能なインターフェースで表示する。

データは 100% ローカルに留まる。Swob は何もアップロードしない。

---

## 主要機能

### Compact された会話の復元

Claude Code はコンテキストを節約するために会話を圧縮する。元のメッセージは JSONL ファイルに残っている — Swob がそれを見つけて、任意の compact ブロックを展開して失われた内容を読めるようにする。**他のツールにこの機能はない。**

### Spotlight セッションジャンプ — `⌘⇧K`

グローバルホットキーで Spotlight 風の検索ウィンドウを表示。コンテンツ、プロジェクト名、フォルダ、時間（`today`、`yesterday`、`this week`）でファジー検索。ソース（`claude`、`codex`、`cursor`）でフィルタリング。ウィンドウを切り替えずに1秒以内で任意のセッションにジャンプ。

### 全文検索 — `⌘K`

全セッションを一括検索。マッチした内容は折りたたまれた compact セクション内でも自動展開されるので、compact されたものでも見つかる。セッション内検索（`⌘F`）は正規表現対応。

### マルチソース：Claude Code + Codex + Cursor

`~/.claude/projects/`、`~/.codex/sessions/`、`~/.cursor/projects/` を読み取り — 3つのツールのすべてのセッションを一か所で閲覧・再開。

### トークンインサイトダッシュボード

- 5つの統計カード：総トークン、セッション数、ターン数、アクティブ日数、推定時間
- 365日コントリビューションヒートマップ（GitHub のように、AI 使用量を可視化）
- ソース別ドーナツチャート（Claude Code vs Codex vs Cursor）
- モデル使用内訳
- プロジェクト別トークン消費ランキング
- 30日間デイリートレンドチャート

### ワンクリック再開

任意のセッションをクリックして Terminal または iTerm2 で再開。フォルダ全体の一括再開も可能。作業ディレクトリと `--dangerously-skip-permissions` モードを自動保持。Codex（`codex resume`）と Cursor（`cursor agent --resume`）にも対応。

### SSH リモート再開

SSH 接続を設定し、アプリから直接リモートサーバー上のセッションを再開。

### CLI — `swob`

```bash
swob search "認証バグ"           # ファジー検索
swob list --source codex        # ソース別フィルタ
swob resume <id>                # 再開コマンド取得
swob insights                   # トークン使用統計
swob active                     # 実行中のセッション表示
swob install                    # CLI + Agent Skill インストール
```

すべてのコマンドは JSON を出力。`swob install` は Claude Code Skill もインストールし、会話中に Claude が `swob` をツールとして呼び出せるようになる。

### セッション整理

ネストフォルダ、ドラッグ＆ドロップ、カスタムタイトル対応のツリービューサイドバー。3つの表示モード：コンパクト（ツールノイズを非表示）、フル（すべて表示）、Markdown（クリーンなエクスポート）。

### ブランチ検出

ファイル間の続き（multi-file continuations）と並行ブランチの分岐を自動検出。サイドチェーン（却下されたプラン）は暗く表示。

### ハイライト＆メモ

任意のテキストを選択してブックマーク。すべてのハイライトは右サイドバーに集約され、クリックで元の位置にジャンプバック — セッションを横断する個人ナレッジトレイル。

### メタデータサイドバー

各セッション表示：作成/更新日時、ターン数、トークン使用量（input/output/cache）、ツール呼び出し統計、Skill 呼び出し記録、ファイル操作ツリー、参照ファイルリスト、推定アクティブ時間。

### iCloud バックアップ

セッションは `~/Documents/Swob/` に可読な Markdown トランスクリプト付きで自動バックアップ。iCloud プレースホルダーファイルを自動検出し、必要に応じてダウンロード。

### アクティブセッション検出

緑のドットで実行中のセッションを表示。`ps` ポーリング（1秒間隔）とファイル変更ウォッチャーで検出。

### ドラッグエクスポート

各セッションは自動的に Markdown としてエクスポート。他のアプリ（Finder、メモ、別の Claude Code セッション）にドラッグして会話間でコンテキストを受け渡し。

### バイリンガル UI

中国語（zh-CN）と英語を完全サポート。

---

## インストール

[**Releases**](https://github.com/IvyYang1999/swob/releases) から最新の `.dmg` をダウンロード。

またはソースからビルド：

```bash
git clone https://github.com/IvyYang1999/swob.git
cd swob
npm install
npm run dev          # 開発モード（ホットリロード）
npm run build:mac    # dist/ に .dmg を生成
```

**動作環境：** macOS（Apple Silicon または Intel）· Claude Code インストール済み

---

## 技術スタック

Electron 40 · React 19 · TypeScript · Zustand · Tailwind CSS 4 · Recharts · electron-vite

---

## 関連プロジェクト

- [claude --resume](https://docs.anthropic.com/en/docs/claude-code) — 内蔵セッション再開（最近のセッションのみ）
- [CC Switch](https://github.com/farion1231/cc-switch) — AI CLI ツールのプロバイダー＆設定マネージャー
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Claude Code ツール集

---

## ライセンス

[AGPL-3.0](LICENSE)
