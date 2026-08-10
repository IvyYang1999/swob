import type { TranslationContributionDescriptor } from '../../shared/contracts/truth-kernel'

/**
 * This is intentionally not wired into the singleton i18n registry. t211I is
 * the only owner of mechanical aggregation for parallel feature bundles.
 */
export const contextLedgerTranslationContribution: TranslationContributionDescriptor = {
  schemaVersion: 1,
  featureId: 't211C-context-ledger',
  namespace: 'context-ledger',
  fallbackLocale: 'en',
  ownedKeys: [
    'title', 'unknown', 'currentSnapshot', 'reportedInput', 'estimatedTokens',
    'introduced', 'preserved', 'summarized', 'dropped', 'mcpExposure',
    'configured', 'instructions', 'toolName', 'schema', 'called', 'result',
    'source', 'time', 'transition', 'trigger', 'operation', 'visibleToModel', 'evidence'
  ],
  locales: {
    en: {
      title: 'Context evidence',
      unknown: 'Unknown / not recorded',
      currentSnapshot: 'Current file state (not historical evidence)',
      reportedInput: 'Provider-reported input',
      estimatedTokens: 'Estimated tokens',
      introduced: 'Introduced',
      preserved: 'Preserved',
      summarized: 'Summarized',
      dropped: 'Dropped',
      mcpExposure: 'MCP evidence',
      configured: 'Configured',
      instructions: 'Instructions visible',
      toolName: 'Tool name visible',
      schema: 'Schema state',
      called: 'Called',
      result: 'Result visible',
      source: 'Source',
      time: 'Time',
      transition: 'Context transition',
      trigger: 'Trigger',
      operation: 'Operation',
      visibleToModel: 'Visible to model',
      evidence: 'Evidence'
    },
    zh: {
      title: '上下文证据',
      unknown: '未知／未记录',
      currentSnapshot: '当前文件状态（不是历史证据）',
      reportedInput: 'Provider 报告的输入',
      estimatedTokens: '估算 Token',
      introduced: '新增',
      preserved: '保留',
      summarized: '压缩摘要',
      dropped: '已移除',
      mcpExposure: 'MCP 证据',
      configured: '已配置',
      instructions: '指令可见',
      toolName: '工具名可见',
      schema: 'Schema 状态',
      called: '已调用',
      result: '结果可见',
      source: '来源',
      time: '时间',
      transition: '上下文转换',
      trigger: '触发方式',
      operation: '操作',
      visibleToModel: '模型可见',
      evidence: '证据'
    }
  }
}
