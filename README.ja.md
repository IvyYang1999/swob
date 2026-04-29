<div align="center">

<h1>Swob</h1>

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

<p><strong>AIは忘れる（compact）。あなたは忘れない。</strong></p>

<p>Claude Code・Codex・Cursor のセッションマネージャー — 任意の会話を閲覧・検索・復元・再開。</p>

<img src="e2e/screenshots/chat-loaded.png" alt="Swob メイン画面" width="800" />

</div>

---

## なぜ Swob が必要か

Claude Code はコンテキストを節約するために会話を compact で圧縮します。圧縮されると元のメッセージは消え、サマリーしか見られなくなります。**Swob はすべてを保持します。**

復元機能だけでなく、Swob は AI コーディングワークフロー全体のコントロールセンターです。数百のセッションをフォルダに整理し、Spotlight 風のショートカットで任意の会話に瞬時にジャンプし、トークンコストを追跡し、SSH 経由でスマートフォンからセッションを再開できます。

---

## 機能

### 🔓 Compact 前の会話復元
圧縮されたセクションを展開して元のメッセージを確認。これができる唯一のツールです。

### ⚡ Spotlight セッションジャンプ（⌘⇧K）
全セッションをまたいだファジー検索。1秒以内に任意の会話へジャンプ。

### 📁 セッションブラウザ＆整理
ネストフォルダ・ドラッグ＆ドロップ・カスタムタイトル・ブランチ検出に対応したツリービューサイドバー。3つの表示モード：コンパクト / フル / Markdown。

### 🔀 マルチソース対応
**Claude Code**・**Codex**・**Cursor CLI** のセッションを一か所で管理。

### 📊 トークンインサイト
365日ヒートマップ、モデル別コスト内訳、プロジェクトランキング、日別タイムライン。トークンの使い道を正確に把握。

### ▶️ ワンクリック再開
Terminal または iTerm2 でワンクリックでセッションを再開。フォルダ全体の一括再開も可能。作業ディレクトリと `--dangerously-skip-permissions` モードを自動保持。

### 🌐 SSH リモート再開
SSH 接続を設定し、アプリから直接リモートサーバー上のセッションを再開。

### 💻 CLI（`swob`）
```bash
swob search "認証バグ"              # セッション検索
swob list --source claude           # ソース別一覧
swob resume <sessionId>             # 再開コマンド取得
swob insights                       # トークン統計
swob active                         # アクティブセッション表示
swob install                        # CLI + Skill インストール
```

### 🔍 全文検索
全セッションをまたいだグローバル検索（⌘K）、正規表現対応のセッション内検索（⌘F）。マッチした内容は compact の折りたたみ内でも自動展開。

### 🖊️ ハイライト＆メモ
任意のテキストを選択してブックマーク。すべてのハイライトはサイドバーに集約され、クリックで元の位置に戻れます。

### ☁️ iCloud 同期
セッションを `~/Documents/Swob/`（iCloud 同期）にバックアップ。iCloud プレースホルダーファイルを自動検出し、必要に応じてダウンロード。

### 🌏 バイリンガル UI
中国語（zh-CN）と英語を完全サポート。

---

## スクリーンショット

<table>
  <tr>
    <td align="center"><b>セッションブラウザ</b></td>
    <td align="center"><b>チャットビュー</b></td>
    <td align="center"><b>グローバル検索</b></td>
  </tr>
  <tr>
    <td><img src="e2e/screenshots/sidebar-loaded.png" alt="セッションブラウザ" /></td>
    <td><img src="e2e/screenshots/chat-loaded.png" alt="チャットビュー" /></td>
    <td><img src="e2e/screenshots/search-opened.png" alt="グローバル検索" /></td>
  </tr>
</table>

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

## 仕組み

Swob は Claude Code・Codex・Cursor がローカルに保存する JSONL 会話ログを読み込みます。セッションファイルを解析し、複数ファイルにまたがる続きやブランチを検出し、compact 前の履歴を再構築して、すべてをビジュアルインターフェースで表示します。データは常にローカル — Swob は何もアップロードしません。

---

## 技術スタック

| | |
|---|---|
| フレームワーク | Electron 40 + React 19 + TypeScript |
| ビルド | electron-vite |
| 状態管理 | Zustand |
| UI | Tailwind CSS 4 |
| チャート | Recharts |
| テスト | Vitest + Playwright |

---

## ライセンス

[AGPL-3.0](LICENSE)
