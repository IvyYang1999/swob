export type Locale = 'zh' | 'en'

export interface Strings {
  lang: string
  hero: {
    brand: string
    headline: string
    sub: string
    cta: string
    secondary: string
  }
  problem: {
    title: string
    pains: { icon: string; title: string; desc: string }[]
  }
  capabilities: {
    label: string
    title: string
    items: { label: string; title: string; desc: string }[]
  }
  trust: {
    label: string
    title: string
    desc: string
    pillars: { title: string; desc: string }[]
  }
  audience: {
    label: string
    title: string
    desc: string
    personas: { emoji: string; role: string; scenario: string }[]
  }
  faq: {
    label: string
    title: string
    items: { q: string; a: string }[]
  }
  footer: {
    ctaTitle: string
    ctaDesc: string
    downloadBtn: string
  }
  nav: {
    capabilities: string
    trust: string
    audience: string
    faq: string
    docs: string
    download: string
  }
}

const zh: Strings = {
  lang: 'zh-CN',
  hero: {
    brand: 'Swob',
    headline: '你的 AI 对话，不该用完就丢',
    sub: 'Swob 将散落在不同工具里的 AI 对话收进本地资料库，让它们可整理、可搜索、可审计，并在来源支持时安全恢复。',
    cta: '免费下载',
    secondary: '了解更多',
  },
  problem: {
    title: '你上个月和 AI 的对话，现在还找得到吗？',
    pains: [
      { icon: '⏳', title: '来源可能清理历史', desc: '部分来源会按自己的保留策略清理历史。上个月花数小时调通的方案，可能在你需要时已经不在原客户端。' },
      { icon: '🗂️', title: '散落多个工具', desc: 'Claude Code、Cursor、Codex、OpenCode……你的对话分布在不同工具、不同设备，很难统一回看。' },
      { icon: '🔍', title: '想引用时找不回', desc: '你记得"上周让 AI 写过一段处理并发的代码"，但找不到是哪个对话、哪个工具。' },
    ],
  },
  capabilities: {
    label: '核心能力',
    title: '四件事，让对话变成资产',
    items: [
      { label: '珍藏', title: '对话像文档一样被收藏整理', desc: '侧栏分组、镜头切换、拖拽整理——你的 AI 对话不再是用完即弃的聊天记录，而是可以反复查阅的文档。' },
      { label: '找回', title: '来源支持且证据完整时，安全恢复', desc: 'Swob 会校验来源、会话 ID、冲突与目标实例；条件不满足时保守失败，不把“备份可读”冒充“可以继续聊”。' },
      { label: '看清', title: 'API 等价值可追溯到具体请求', desc: '处理了多少 Token、对应多少 API 等价值、哪些会话最重要——保留模型、定价与覆盖率标签，不冒充真实账单。' },
      { label: '随身', title: '问已解析的历史：我上周干了啥？', desc: '悬浮窗助手可以检索 Swob 已原生解析的历史会话；实验性检测来源尚不能读取消息正文。' },
    ],
  },
  trust: {
    label: '信任',
    title: '你的数据，你做主',
    desc: '像 Obsidian 一样，Swob 相信：软件应该尊重用户对数据的完全控制。',
    pillars: [
      { title: '本地优先', desc: '核心会话与索引保存在你的硬盘上；只有你主动启用的联网动作，才会按明确范围访问网络。' },
      { title: '零遥测', desc: 'Swob 不收集使用行为、不发送崩溃报告、不跟踪你打开了什么。' },
      { title: '文件就是你的', desc: '会话存储为标准文件，放在你选择的文件夹。iCloud 同步、搬家、备份——随你。' },
      { title: '开源', desc: '源码公开在 GitHub。你可以审计每一行代码，确认我们说的和做的一致。' },
    ],
  },
  audience: {
    label: '给谁用',
    title: '不只是程序员的工具',
    desc: '只要你经常使用 AI，对话就值得被保存、整理和再次使用。',
    personas: [
      { emoji: '👩‍💻', role: '程序员', scenario: '用 Claude Code / Cursor 写代码，上周那个 debug 会话要复查——Swob 全文搜索秒定位。' },
      { emoji: '✍️', role: '写作者', scenario: '用 AI 润色文章、翻译材料，成果散落在三个工具里——Swob 统一收纳，随时引用。' },
      { emoji: '🔬', role: '研究者', scenario: '和 AI 反复探讨一个主题，对话是研究笔记——Swob 让它们像文档一样可整理、可回溯。' },
    ],
  },
  faq: {
    label: 'FAQ',
    title: '常见问题',
    items: [
      { q: 'Swob 是免费的吗？', a: '是的。Swob 是免费、开源的桌面应用，不需要账号、不需要订阅。' },
      { q: 'Swob 支持哪些 AI 工具？', a: '目前有 6 个原生读取来源、1 个 Claude 兼容格式，以及 4 个仅能发现文件的实验来源。完整能力边界见文档。' },
      { q: '我的数据会上传到云端吗？', a: '核心浏览、搜索与索引默认留在本机。只有你主动触发的联网功能，才会把明确范围的数据发送给所选服务。' },
      { q: '"复活"是怎么实现的？', a: '当来源支持写回且备份证据完整时，Swob 会校验目标、冲突和会话 ID 后再恢复；条件不足时会停止并说明原因。' },
      { q: '支持 Windows / Linux 吗？', a: '目前 Swob 只支持 macOS。Windows 版正在开发中。' },
    ],
  },
  footer: {
    ctaTitle: '让你的 AI 对话，成为你拥有的东西',
    ctaDesc: '免费、开源、本地优先。下载 Swob，开始整理你的 AI 对话。',
    downloadBtn: '免费下载 macOS 版',
  },
  nav: {
    capabilities: '能力',
    trust: '信任',
    audience: '给谁用',
    faq: 'FAQ',
    docs: '文档',
    download: '下载',
  },
}

const en: Strings = {
  lang: 'en',
  hero: {
    brand: 'Swob',
    headline: 'Your AI Conversations Deserve Better',
    sub: 'Swob brings AI conversations scattered across different tools into a local library—organized, searchable, auditable, and safely recoverable where supported.',
    cta: 'Download Free',
    secondary: 'Learn More',
  },
  problem: {
    title: 'Can you still find last month\'s AI conversations?',
    pains: [
      { icon: '⏳', title: 'Sources may purge history', desc: 'Some sources clean up history under their own retention rules. The session you need may already be gone from the original client.' },
      { icon: '🗂️', title: 'Scattered across tools', desc: 'Claude Code, Cursor, Codex, OpenCode… your conversations live in different tools and devices, making them hard to revisit together.' },
      { icon: '🔍', title: 'Impossible to reference', desc: 'You remember asking AI to write some concurrency code last week, but can\'t find which conversation or which tool.' },
    ],
  },
  capabilities: {
    label: 'Capabilities',
    title: 'Four things that turn conversations into assets',
    items: [
      { label: 'Collect', title: 'Organize conversations like documents', desc: 'Sidebar groups, lens switching, drag-and-drop — your AI conversations become reusable documents, not throwaway chat logs.' },
      { label: 'Recover', title: 'Safe recovery when the source and evidence support it', desc: 'Swob validates the source, session ID, target instance, and conflicts. It fails closed rather than pretending every readable backup can be resumed.' },
      { label: 'Insight', title: 'API-equivalent value traceable to requests', desc: 'See tokens and API-equivalent value with model, pricing, and coverage labels intact — never presented as an actual bill.' },
      { label: 'Companion', title: 'Ask the history Swob can actually parse', desc: 'The floating assistant searches sessions parsed by native adapters. Experimental detection-only sources do not expose message bodies yet.' },
    ],
  },
  trust: {
    label: 'Trust',
    title: 'Your data, your rules',
    desc: 'Like Obsidian, Swob believes software should respect users\' complete control over their data.',
    pillars: [
      { title: 'Local-first', desc: 'Core sessions and indexes stay on your drive. Only actions you explicitly enable may access the network within a stated boundary.' },
      { title: 'Zero telemetry', desc: 'Swob doesn\'t collect usage behavior, send crash reports, or track what you open.' },
      { title: 'Files are yours', desc: 'Sessions are stored as standard files in your chosen folder. iCloud sync, migration, backup — your call.' },
      { title: 'Open source', desc: 'Source code is public on GitHub. You can audit every line to verify we do what we say.' },
    ],
  },
  audience: {
    label: 'Who it\'s for',
    title: 'Not just a developer tool',
    desc: 'If you use AI regularly, those conversations are worth saving, organizing, and revisiting.',
    personas: [
      { emoji: '👩‍💻', role: 'Developers', scenario: 'Use Claude Code / Cursor for coding — need to review last week\'s debug session? Swob\'s full-text search finds it instantly.' },
      { emoji: '✍️', role: 'Writers', scenario: 'Polish articles and translate with AI — outputs scattered across three tools. Swob unifies them for easy reference.' },
      { emoji: '🔬', role: 'Researchers', scenario: 'Discuss topics iteratively with AI — conversations become research notes. Swob makes them organizable and traceable.' },
    ],
  },
  faq: {
    label: 'FAQ',
    title: 'Frequently Asked Questions',
    items: [
      { q: 'Is Swob free?', a: 'Yes. Swob is a free, open-source desktop app. No account or subscription required.' },
      { q: 'Which AI tools does Swob support?', a: 'Swob currently has 6 native readers, 1 Claude-compatible format, and 4 experimental sources that can only detect files. See the docs for exact capability boundaries.' },
      { q: 'Will my data be uploaded to the cloud?', a: 'Core browsing, search, and indexing stay local by default. Only network features you explicitly trigger send a stated scope of data to your chosen service.' },
      { q: 'How does "revive" work?', a: 'When a source supports write-back and the backup evidence is complete, Swob validates the target, conflicts, and session ID before recovery. Otherwise it stops and explains why.' },
      { q: 'Does it support Windows / Linux?', a: 'Currently Swob only supports macOS. Windows support is under development.' },
    ],
  },
  footer: {
    ctaTitle: 'Turn your AI conversations into something you own',
    ctaDesc: 'Free, open-source, local-first. Download Swob and start organizing your AI conversations.',
    downloadBtn: 'Free Download for macOS',
  },
  nav: {
    capabilities: 'Features',
    trust: 'Trust',
    audience: 'For Who',
    faq: 'FAQ',
    docs: 'Docs',
    download: 'Download',
  },
}

const strings: Record<Locale, Strings> = { zh, en }

let currentLocale: Locale = 'zh'

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(l: Locale) {
  currentLocale = l
}

export function t(): Strings {
  return strings[currentLocale]
}

export function detectLocale(): Locale {
  const path = window.location.pathname
  if (path.includes('/en/') || path.endsWith('/en')) return 'en'
  return 'zh'
}
