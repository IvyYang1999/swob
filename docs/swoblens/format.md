# `.swoblens` 声明式扩展包格式 v1

`.swoblens` 是 Swob 的零代码扩展格式。它是一个小型 ZIP，只能包含根目录的 `manifest.json` 和一个由 manifest 声明的 JSON 文件。格式没有入口点、权限、hook、URL 或脚本字段；未知字段会使整个包被拒绝。

## 安全与资源边界

- 压缩包最大 2 MiB，最多 16 个文件；单文件最大 256 KiB，解压总量最大 512 KiB，压缩比最大 50:1。
- 只允许 stored 或 deflate 条目；拒绝 ZIP64、加密、多盘、streaming data descriptor、重叠条目、重复路径和畸形 central directory。
- 拒绝绝对路径、反斜线、`.`/`..`、路径穿越、symlink、非普通 Unix 文件和 Unix link metadata。
- 拒绝 JS/TS/Wasm/HTML/SVG/shell/原生二进制等可执行扩展名。
- manifest、声明文件和安装状态均按白名单 schema 校验；声明文件的大小与 SHA-256 必须匹配。
- 安装器只从已经打开并稳定读取的文件句柄解析一次；安装时再次校验预览 digest，避免“校验后替换”。
- 安装在 Library 的 `.swob/packages/<package-id>/`。升级、启停和卸载持有 Library 单写者锁并使用同卷原子 rename；同版本冲突和降级会被拒绝。
- `SWOB_PLUGIN_EXECUTION_ENABLED` 始终为 `false`。包不能发起网络请求，也不能获得文件系统能力。

## `manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "org.example.my-theme",
  "name": { "zh-CN": "我的主题", "en": "My Theme" },
  "version": "1.0.0",
  "type": "theme",
  "author": "Example Author",
  "minSwobVersion": "1.3.1",
  "declaration": "theme.json",
  "files": [
    {
      "path": "theme.json",
      "sha256": "<64 个小写十六进制字符>",
      "bytes": 320
    }
  ]
}
```

v1 只允许一个声明文件。`id` 只含小写字母、数字、点或连字符；`version` 与 `minSwobVersion` 使用 SemVer 2.0。

## 主题包 `theme`

```json
{
  "schemaVersion": 1,
  "label": { "zh-CN": "极光静谧", "en": "Aurora Calm" },
  "mode": "dark",
  "tokens": {
    "base": "#111827",
    "surface": "#1f2937",
    "primary": "#e5e7eb",
    "accent": "#67e8f9"
  }
}
```

`mode` 为 `light`、`dark` 或 `both`。token key 必须来自 `SWOBLENS_THEME_TOKEN_KEYS`；value 只允许六位或八位十六进制颜色，因此 `url()`、`@import`、选择器和任意 CSS 都无法进入渲染器。

## Lens 预设包 `lens-preset`

```json
{
  "schemaVersion": 1,
  "label": { "zh-CN": "学术研究套装", "en": "Research Kit" },
  "enabledLenses": ["highlights", "image-index", "outputs", "share-templates"],
  "order": ["highlights", "image-index", "outputs", "share-templates", "token-insights", "galaxy", "audit"],
  "sceneTags": ["knowledge"]
}
```

`enabledLenses` 只能引用内置 Lens；`order` 必须无重复地列出全部内置 Lens。scene tag 只允许 `knowledge`、`developer`、`team`。

## 分享图模板包 `share-template`

```json
{
  "schemaVersion": 1,
  "label": { "zh-CN": "田野笔记卡", "en": "Field Notes Card" },
  "layout": "compact",
  "watermark": "Captured with Swob",
  "colors": {
    "bg": "base",
    "cardBg": "surface",
    "text": "primary",
    "textSecondary": "secondary",
    "textMuted": "muted",
    "userAccent": "soft-blue",
    "assistantAccent": "soft-orange",
    "border": "edge"
  }
}
```

`layout` 只允许 `compact`、`conversation`、`poster`。watermark 是最长 80 字符的纯文本。颜色只能引用受信主题 token，不能写 CSS 值或绘制代码。

## 官方示例与固定 digest

可安装示例位于 [`examples/`](./examples/)；其固定 SHA-256 记录在 [`SHA256SUMS`](./examples/SHA256SUMS)。运行 `npm run swoblens:check` 可验证二进制包与生成源一致。
