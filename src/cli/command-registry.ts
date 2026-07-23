/** Keep in lockstep with package.json; covered by the CLI contract test. */
export const CLI_VERSION = '1.3.1'

export const CLI_EXIT_CODES = [
  { code: 0, meaning: '成功' },
  { code: 1, meaning: '参数、输入或执行错误' },
  { code: 2, meaning: '标识符歧义' },
  { code: 3, meaning: '目标不存在' }
] as const

export interface CliCommandDefinition {
  usage: string
  summary: string
  output: string
  examples: string[]
}

export const CLI_COMMANDS: readonly CliCommandDefinition[] = [
  { usage: 'search <query> [--limit N]', summary: '按标题、项目、文件夹等元数据搜索会话', output: 'JSON 会话数组', examples: ['swob search "认证失败" --limit 10'] },
  { usage: 'list [--folder ID|NAME] [--source SOURCE] [--project TEXT] [--limit N]', summary: '列出并筛选会话', output: 'JSON 会话数组', examples: ['swob list --project swob --source codex'] },
  { usage: 'show <sessionId> [--full] [--format=jsonl]', summary: '查看会话；--full 保留全文、thinking、工具参数和结果', output: 'JSON 对象；jsonl 模式每行一个 session/message 事件', examples: ['swob show <id> --full', 'swob show <id> --full --format=jsonl'] },
  { usage: 'grep <query> [--source SOURCE] [--folder ID|NAME] [--after DATE] [--before DATE] [--project TEXT] [--limit N]', summary: '用 SQLite FTS 搜索完整 transcript，并返回命中消息上下文 ±1', output: 'JSON 搜索结果', examples: ['swob grep "permission denied" --project swob --after 2026-07-01'] },
  { usage: 'resume <sessionId> [--cwd PATH] [--skip-permissions]', summary: '生成恢复会话的命令', output: 'JSON { command }', examples: ['swob resume <id>'] },
  { usage: 'resume-audit [--json]', summary: '只读审计全部会话的恢复可信度', output: '文本报告；--json 时为 JSON', examples: ['swob resume-audit --json'] },
  { usage: 'resolve <sessionId> [--json]', summary: '把旧 ID 或短 ID 解析为最新完整 ID', output: '默认一行 ID；--json 时为 JSON', examples: ['swob resolve <short-id> --json'] },
  { usage: 'lineage [--dry-run]', summary: '重建会话血统注册表', output: 'JSON 注册表', examples: ['swob lineage --dry-run'] },
  { usage: 'folders', summary: '列出 Vault 文件夹树', output: 'JSON 文件夹树', examples: ['swob folders'] },
  { usage: 'folder create <name> [--parent ID]', summary: '创建文件夹', output: 'JSON 结果', examples: ['swob folder create "swob"'] },
  { usage: 'folder rename <id> <name>', summary: '重命名文件夹', output: 'JSON 结果', examples: ['swob folder rename work "工作"'] },
  { usage: 'folder delete <id>', summary: '删除空的受管文件夹', output: 'JSON 结果', examples: ['swob folder delete archive'] },
  { usage: 'move <sessionId> <folderId>', summary: '事务式移动一个会话', output: 'JSON 结果', examples: ['swob move <id> work'] },
  { usage: 'move --stdin', summary: '从 stdin 读取 JSONL 或 JSON 数组，原子提交批量移动', output: 'JSON 事务结果', examples: ['printf \'{"sessionId":"<id>","folderId":"work"}\\n\' | swob move --stdin'] },
  { usage: 'rename <sessionId> <title>', summary: '事务式重命名一个会话', output: 'JSON 结果', examples: ['swob rename <id> "CLI 设计"'] },
  { usage: 'rename --stdin', summary: '从 stdin 读取 JSONL 或 JSON 数组，原子提交批量重命名', output: 'JSON 事务结果', examples: ['printf \'{"sessionId":"<id>","title":"CLI 设计"}\\n\' | swob rename --stdin'] },
  { usage: 'undo', summary: '撤销最近一次 move/rename 组织事务', output: 'JSON 事务结果', examples: ['swob undo'] },
  { usage: 'insights [--json] [--summary]', summary: '查看会话统计；token 汇总明确标注 input_plus_output', output: 'JSON 统计', examples: ['swob insights --summary'] },
  { usage: 'config get [key]', summary: '读取设置', output: 'JSON', examples: ['swob config get terminalApp'] },
  { usage: 'config set <key> <value>', summary: '修改设置', output: 'JSON', examples: ['swob config set terminalApp iTerm2'] },
  { usage: 'active', summary: '列出活跃会话', output: 'JSON', examples: ['swob active'] },
  { usage: 'transcript rebuild --all [--dry-run] [--missing-only]', summary: '重建 Library transcript', output: 'JSON', examples: ['swob transcript rebuild --all --missing-only'] },
  { usage: 'redact [--dry-run]', summary: '对派生 transcript 回填脱敏', output: 'JSON', examples: ['swob redact --dry-run'] },
  { usage: 'install', summary: '安装或更新 CLI wrapper 和本 Skill', output: 'JSON 安装结果', examples: ['swob install'] }
] as const

export function cliHelpData(): Record<string, unknown> {
  return {
    name: 'swob',
    version: CLI_VERSION,
    usage: 'swob <command> [arguments] [options]',
    commands: CLI_COMMANDS,
    globalOptions: [
      { flag: '--help', meaning: '显示帮助；与 --json 合用时输出 JSON' },
      { flag: '--version', meaning: '显示版本；与 --json 合用时输出 JSON' },
      { flag: '--json', meaning: '强制机器可解析 JSON，stdout 不含日志' }
    ],
    exitCodes: CLI_EXIT_CODES
  }
}

export function renderCliHelp(): string {
  const commandLines = CLI_COMMANDS.map((command) => `  ${command.usage.padEnd(78)} ${command.summary}`)
  return [
    `Swob CLI ${CLI_VERSION} — AI 编程助手会话管理`,
    '',
    '用法: swob <command> [arguments] [options]',
    '',
    '命令:',
    ...commandLines,
    '',
    '全局选项:',
    '  --help                     显示帮助（可加 --json）',
    '  --version                  显示版本（可加 --json）',
    '  --json                     stdout 仅输出 JSON；诊断信息写入 stderr',
    '',
    '退出码: 0 成功；1 错误；2 歧义；3 不存在',
    ''
  ].join('\n')
}

export function generateSkillContent(): string {
  const commands = CLI_COMMANDS.map((command) => [
    `### \`swob ${command.usage}\``,
    '',
    command.summary,
    '',
    `输出：${command.output}。`,
    '',
    '```bash',
    ...command.examples,
    '```'
  ].join('\n')).join('\n\n')

  const exitCodes = CLI_EXIT_CODES.map(({ code, meaning }) => `- ${code}: ${meaning}`).join('\n')
  return `# Swob CLI — Agent Skill

Swob 管理 Claude Code、Codex、Cursor 等 AI 编程助手的会话。Agent 应优先使用本 CLI 的结构化输出，不直接修改 Vault 会话包。

## 机器接口契约

- 带 \`--json\` 的命令，stdout 只包含一个合法 JSON 值；日志与警告只写 stderr。
- \`show --format=jsonl\` 的 stdout 每行是一个独立 JSON 事件。
- token 汇总指标名为 \`input_plus_output\`，不包含 cache creation/read。
- 批量 move/rename 接受 JSONL，也兼容一个 JSON 数组；整批先校验再提交。

退出码：

${exitCodes}

## 命令参考

${commands}

## 推荐工作流

### 找到并恢复会话

1. \`swob grep "原文关键词" --project <name>\` 搜全文；或用 \`swob search\` 搜元数据。
2. \`swob show <id> --full\` 核对正文与工具调用。
3. \`swob resume <id>\` 获取恢复命令。

### 安全批量整理

1. 用 \`swob list\` 和 \`swob folders\` 取得精确 ID。
2. 把整批 JSONL 送入 \`swob move --stdin\` 或 \`swob rename --stdin\`。
3. 若结果不符合预期，立即执行 \`swob undo\`；每次 undo 只撤销最近一个组织事务。
`
}
