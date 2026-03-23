import { useStore } from './store'

export type Locale = 'zh-CN' | 'en'

const translations: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    // App
    'error.render': '渲染错误',
    'error.retry': '重试',

    // Toolbar
    'toolbar.search_placeholder': '搜索所有对话...',
    'toolbar.toggle_info': '切换信息面板',
    'toolbar.language': '语言',

    // Sidebar
    'sidebar.sessions': 'Sessions',
    'sidebar.tree_view': '切换为树状视图',
    'sidebar.timeline_view': '切换为时间线视图',
    'sidebar.new_folder': '新建文件夹',
    'sidebar.folder_name': '文件夹名称',
    'sidebar.subfolder_name': '子文件夹名称',
    'sidebar.all_sessions': '全部对话',
    'sidebar.ungrouped': '未分组',
    'sidebar.single_turn': '单轮对话',
    'sidebar.yesterday': '昨天',
    'sidebar.days_ago': '{n}天前',
    'sidebar.turns': '{n}轮',
    'sidebar.opened_in_terminal': '已在终端打开',
    'sidebar.batch_resume': '批量 Resume {n} 个对话',
    'sidebar.new_subfolder': '新建子文件夹',
    'sidebar.delete_folder': '删除文件夹「{name}」？（含子文件夹，不会删除对话）',
    'sidebar.drop_here': '拖拽对话到这里',
    'sidebar.stats': '{n} sessions · {size}',

    // ChatViewer
    'chat.select_session': '选择一个 Session 查看对话',
    'chat.compact': '精简',
    'chat.full': '完整',
    'chat.md': 'MD',
    'chat.toc': '目录',
    'chat.search_session': '对话内搜索 (Cmd+F)',
    'chat.multi_select': '多选模式',
    'chat.preview': '预览',
    'chat.source': '源码',
    'chat.copied': '已复制',
    'chat.copy': '复制',
    'chat.download_md': '下载 MD',
    'chat.resume_branch_hint': '分支对话无法单独恢复，将打开主对话',
    'chat.resume_parent': '主对话',
    'chat.copy_resume_cmd': '复制 resume 命令',
    'chat.copy_resume_cmd_short': '复制命令',
    'chat.turns_count': '{n} 轮对话',
    'chat.current_section': '当前对话',
    'chat.copy_question': '复制问题',
    'chat.copy_answer': '复制回答',
    'chat.compact_summary': 'Compact 上下文摘要',
    'chat.search_placeholder': '搜索...',
    'chat.prev_match': '上一个 (Shift+Enter)',
    'chat.next_match': '下一个 (Enter)',
    'chat.close_esc': '关闭 (Esc)',
    'chat.close': '关闭',
    'chat.selected_count': '已选 {n} 项',
    'chat.cancel': '取消',
    'chat.highlight': '划线',
    'chat.highlight_title': '划线收藏',

    // Sections (markdown.ts)
    'section.shared_context': '共享上下文 — 分支前的对话 ({n} 轮)',
    'section.original': '原始对话 ({n} 轮)',
    'section.compact_after': 'Compact #{i} 后 ({n} 轮)',
    'section.current': '当前对话',
    'section.compact_summary_md': '> *Compact 上下文摘要*',
    'section.turns_label': '{n} 轮对话',

    // SearchResults
    'search.summary': '搜索 "{query}" — {sessions} 个 session，{matches} 处匹配',
    'search.matches': '{n} 处匹配',

    // InfoPanel
    'info.title': 'Session Info',
    'info.created': '创建：{time}',
    'info.modified': '修改：{time}',
    'info.turns': '{n} 轮对话',
    'info.working_dirs': '工作目录',
    'info.uploaded_images': '上传图片',
    'info.files_operated': '操作过的文件',
    'info.tool_usage': '工具调用',
    'info.skill_invocations': 'Skill 调用',
    'info.claude_docs': '.claude 文档',
    'info.highlights': '划线笔记',
    'info.highlight_jump': '点击跳转到划线位置',
    'info.highlight_delete': '删除划线',
    'info.highlight_copy': '复制划线内容',
    'info.config_files': '配置文件',
    'info.file_click_hint': '点击打开 · 右键在 Finder 中显示',
    'info.file_deleted': '(已删除)',
    'info.file_actions': '操作: {actions}',
    'info.show_more': '还有 {n} 个...',
    'info.action_write': '新建',
    'info.action_edit': '编辑',
    'info.action_read': '读取',
    'info.action_upload': '上传',
    'info.action_user': '用户',
  },

  'en': {
    // App
    'error.render': 'Render Error',
    'error.retry': 'Retry',

    // Toolbar
    'toolbar.search_placeholder': 'Search all sessions...',
    'toolbar.toggle_info': 'Toggle info panel',
    'toolbar.language': 'Language',

    // Sidebar
    'sidebar.sessions': 'Sessions',
    'sidebar.tree_view': 'Switch to tree view',
    'sidebar.timeline_view': 'Switch to timeline view',
    'sidebar.new_folder': 'New folder',
    'sidebar.folder_name': 'Folder name',
    'sidebar.subfolder_name': 'Subfolder name',
    'sidebar.all_sessions': 'All sessions',
    'sidebar.ungrouped': 'Ungrouped',
    'sidebar.single_turn': 'Single-turn',
    'sidebar.yesterday': 'Yesterday',
    'sidebar.days_ago': '{n}d ago',
    'sidebar.turns': '{n} turns',
    'sidebar.opened_in_terminal': 'Opened in terminal',
    'sidebar.batch_resume': 'Batch resume {n} sessions',
    'sidebar.new_subfolder': 'New subfolder',
    'sidebar.delete_folder': 'Delete folder "{name}"? (subfolders included, sessions kept)',
    'sidebar.drop_here': 'Drop sessions here',
    'sidebar.stats': '{n} sessions · {size}',

    // ChatViewer
    'chat.select_session': 'Select a session to view',
    'chat.compact': 'Compact',
    'chat.full': 'Full',
    'chat.md': 'MD',
    'chat.toc': 'TOC',
    'chat.search_session': 'Search in session (Cmd+F)',
    'chat.multi_select': 'Multi-select',
    'chat.preview': 'Preview',
    'chat.source': 'Source',
    'chat.copied': 'Copied',
    'chat.copy': 'Copy',
    'chat.download_md': 'Download MD',
    'chat.resume_branch_hint': 'Branch conversations cannot be resumed separately — opens the main session',
    'chat.resume_parent': 'main',
    'chat.copy_resume_cmd': 'Copy resume command',
    'chat.copy_resume_cmd_short': 'Copy cmd',
    'chat.turns_count': '{n} turns',
    'chat.current_section': 'Current',
    'chat.copy_question': 'Copy question',
    'chat.copy_answer': 'Copy answer',
    'chat.compact_summary': 'Compact context summary',
    'chat.search_placeholder': 'Search...',
    'chat.prev_match': 'Previous (Shift+Enter)',
    'chat.next_match': 'Next (Enter)',
    'chat.close_esc': 'Close (Esc)',
    'chat.close': 'Close',
    'chat.selected_count': '{n} selected',
    'chat.cancel': 'Cancel',
    'chat.highlight': 'Highlight',
    'chat.highlight_title': 'Highlight & save',

    // Sections
    'section.shared_context': 'Shared context — before branch ({n} turns)',
    'section.original': 'Original conversation ({n} turns)',
    'section.compact_after': 'After Compact #{i} ({n} turns)',
    'section.current': 'Current',
    'section.compact_summary_md': '> *Compact context summary*',
    'section.turns_label': '{n} turns',

    // SearchResults
    'search.summary': 'Search "{query}" — {sessions} sessions, {matches} matches',
    'search.matches': '{n} matches',

    // InfoPanel
    'info.title': 'Session Info',
    'info.created': 'Created: {time}',
    'info.modified': 'Modified: {time}',
    'info.turns': '{n} turns',
    'info.working_dirs': 'Working directories',
    'info.uploaded_images': 'Uploaded images',
    'info.files_operated': 'Files operated',
    'info.tool_usage': 'Tool usage',
    'info.skill_invocations': 'Skill invocations',
    'info.claude_docs': '.claude docs',
    'info.highlights': 'Highlights',
    'info.highlight_jump': 'Click to jump to highlight',
    'info.highlight_delete': 'Delete highlight',
    'info.highlight_copy': 'Copy highlight text',
    'info.config_files': 'Config files',
    'info.file_click_hint': 'Click to open · Right-click to show in Finder',
    'info.file_deleted': '(deleted)',
    'info.file_actions': 'Actions: {actions}',
    'info.show_more': '{n} more...',
    'info.action_write': 'Create',
    'info.action_edit': 'Edit',
    'info.action_read': 'Read',
    'info.action_upload': 'Upload',
    'info.action_user': 'User',
  }
}

/**
 * Translate a key with optional interpolation.
 * Usage: t('sidebar.days_ago', { n: 3 }) → "3天前" or "3d ago"
 */
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  let text = translations[locale]?.[key] || translations['en']?.[key] || key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return text
}

/** React hook: returns t() bound to the current locale */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useStore((s) => s.locale)
  return (key: string, params?: Record<string, string | number>) => translate(locale, key, params)
}

export { translations }
