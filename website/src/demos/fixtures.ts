export interface Session {
  id: string
  title: string
  source: string
  sourceColor: string
  date: string
  turns: number
  active?: boolean
  deleted?: boolean
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
}

export const SESSIONS: Session[] = [
  { id: 's1', title: '重构用户认证模块', source: 'Claude Code', sourceColor: 'var(--color-soft-purple)', date: '今天 14:23', turns: 42, active: true },
  { id: 's2', title: '数据库迁移方案讨论', source: 'Cursor', sourceColor: 'var(--color-soft-blue)', date: '今天 11:05', turns: 28 },
  { id: 's3', title: 'API 限流策略设计', source: 'Claude Code', sourceColor: 'var(--color-soft-purple)', date: '昨天 18:30', turns: 35 },
  { id: 's4', title: '前端性能优化分析', source: 'OpenCode', sourceColor: 'var(--color-soft-green)', date: '昨天 09:12', turns: 19 },
  { id: 's5', title: '部署脚本自动化', source: 'Codex', sourceColor: 'var(--color-soft-orange)', date: '07-20 15:40', turns: 56 },
  { id: 's6', title: '单元测试覆盖率提升', source: 'Cursor', sourceColor: 'var(--color-soft-blue)', date: '07-19 10:22', turns: 31 },
  { id: 's7', title: 'WebSocket 实时通信方案', source: 'Claude Code', sourceColor: 'var(--color-soft-purple)', date: '07-18 16:45', turns: 47, deleted: true },
  { id: 's8', title: '日志聚合系统设计', source: 'Zcode', sourceColor: 'var(--color-soft-green)', date: '07-17 11:30', turns: 23, deleted: true },
]

export const FOLDERS = [
  { name: '后端架构', sessions: ['s1', 's3', 's5'] },
  { name: '前端优化', sessions: ['s4', 's6'] },
  { name: '基础设施', sessions: ['s2', 's7', 's8'] },
]

export const CHAT_MESSAGES: Message[] = [
  { role: 'user', content: '帮我重构 AuthService，把密码哈希从 MD5 换成 bcrypt。' },
  { role: 'assistant', content: '好的，我来分析当前的 AuthService 结构。首先需要：\n1. 替换哈希算法\n2. 添加迁移逻辑（老用户首次登录时自动升级）\n3. 更新相关测试' },
  { role: 'tool', content: 'Read src/services/auth-service.ts' },
  { role: 'assistant', content: '我看到当前使用了 `crypto.createHash(\'md5\')`。这里的改动点很明确——我先写测试，然后实现迁移逻辑。' },
]

export const AGENT_MESSAGES: Message[] = [
  { role: 'user', content: '我上周写了一个处理并发请求的方案，在哪个对话里？' },
  { role: 'assistant', content: '找到了！在 7 月 18 日的「WebSocket 实时通信方案」对话中，第 23 轮你讨论了并发请求的队列策略：\n\n> "用 BullMQ 做请求队列，配合 Redis 做分布式锁，限制每个用户同时 5 个并发连接"\n\n要打开这个会话吗？' },
  { role: 'user', content: '帮我找一下上个月 API 等价值最高的是哪个项目' },
  { role: 'assistant', content: '根据带定价口径的 Insights 估算，上个月 API 等价值 Top 3：\n1. **后端架构重构** — 2.4M tokens（API 等价值 $7.20）\n2. **数据库迁移** — 1.8M tokens（API 等价值 $5.40）\n3. **前端性能优化** — 0.9M tokens（API 等价值 $2.70）' },
]

export const INSIGHT_STATS = {
  totalTokens: '12.8M',
  totalCost: '$38.40',
  sessions: 47,
  avgTurns: 34,
  topProject: '后端架构重构',
  topModel: 'Claude Opus 4.6',
  ranking: [
    { name: '后端架构重构', tokens: '4.2M', cost: '$12.60', pct: 33 },
    { name: '数据库迁移', tokens: '2.8M', cost: '$8.40', pct: 22 },
    { name: '前端性能优化', tokens: '2.1M', cost: '$6.30', pct: 16 },
    { name: '基础设施', tokens: '1.9M', cost: '$5.70', pct: 15 },
    { name: '其它', tokens: '1.8M', cost: '$5.40', pct: 14 },
  ],
}
