const escaped = {
  'interactionLedger.title': '\\u4f1a\\u8bdd\\u8f68\\u8ff9', 'interactionLedger.empty': '\\u6682\\u65e0\\u53ef\\u7528\\u7684\\u4ea4\\u4e92\\u4e8b\\u5b9e\\u3002',
  'interactionLedger.round': '\\u8f6e\\u6b21', 'interactionLedger.wall': '\\u603b\\u65f6\\u957f', 'interactionLedger.active': 'Agent \\u6d3b\\u8dc3',
  'interactionLedger.wait': '\\u7b49\\u5f85', 'interactionLedger.tools': '\\u5de5\\u5177', 'interactionLedger.usage': '\\u8f6e\\u6b21\\u7528\\u91cf',
  'interactionLedger.files': '\\u8f6e\\u6b21\\u6587\\u4ef6', 'interactionLedger.valuationGroup': '\\u8f6e\\u6b21\\u4f30\\u4ef7',
  'interactionLedger.valuation': '\\u4f30\\u4ef7', 'interactionLedger.public': '\\u516c\\u5f00\\u7b49\\u4ef7\\u503c', 'interactionLedger.contract': '\\u5408\\u540c\\u5b9e\\u9645\\u4ef7',
  'interactionLedger.fork': '\\u5206\\u53c9\\u8fb9\\u754c', 'interactionLedger.evidence': '\\u67e5\\u770b\\u8bc1\\u636e',
  'interactionLedger.models': '\\u6a21\\u578b\\u8c03\\u7528', 'interactionLedger.grade': '\\u8bc1\\u636e\\u7b49\\u7ea7',
  'interactionLedger.rollups': '\\u5206\\u652f\\u6210\\u672c\\u53e3\\u5f84', 'interactionLedger.fileRevision': '\\u7248\\u672c',
  'interactionLedger.artifacts': '\\u4ea7\\u7269\\u7248\\u672c',
  'interactionLedger.basis.physical-session-usage': '\\u539f\\u59cb\\u7269\\u7406\\u4f1a\\u8bdd',
  'interactionLedger.basis.current-branch-incremental-usage': '\\u5f53\\u524d\\u5206\\u652f\\u589e\\u91cf',
  'interactionLedger.basis.lineage-unique-usage': '\\u8c31\\u7cfb\\u53bb\\u91cd\\u552f\\u4e00\\u91cf',
  'interactionLedger.state.available': '\\u53ef\\u7528', 'interactionLedger.state.unavailable': '\\u4e0d\\u53ef\\u7528',
  'interactionLedger.state.unknown': '\\u672a\\u77e5', 'interactionLedger.state.ambiguous': '\\u6709\\u6b67\\u4e49', 'interactionLedger.state.exact': '\\u7cbe\\u786e',
  'interactionLedger.measurement.exact': '\\u7cbe\\u786e', 'interactionLedger.measurement.derived': '\\u6d3e\\u751f',
  'interactionLedger.measurement.estimated': '\\u4f30\\u7b97', 'interactionLedger.measurement.unavailable': '\\u4e0d\\u53ef\\u7528',
  'interactionLedger.lineage.inherited': '\\u7ee7\\u627f', 'interactionLedger.lineage.independent': '\\u72ec\\u7acb',
  'interactionLedger.lineage.unknown': '\\u672a\\u77e5', 'interactionLedger.quantity.input-token': '\\u8f93\\u5165 Token',
  'interactionLedger.quantity.output-token': '\\u8f93\\u51fa Token', 'interactionLedger.quantity.cache-read-token': '\\u7f13\\u5b58\\u8bfb\\u53d6 Token',
  'interactionLedger.quantity.cache-write-token': '\\u7f13\\u5b58\\u5199\\u5165 Token', 'interactionLedger.quantity.reasoning-token': '\\u63a8\\u7406 Token',
  'interactionLedger.quantity.tool-token': '\\u5de5\\u5177 Token', 'interactionLedger.quantity.non-token': '\\u975e Token \\u7528\\u91cf',
  'interactionLedger.unit.token': 'Token', 'interactionLedger.unit.request': '\\u8bf7\\u6c42', 'interactionLedger.unit.image': '\\u56fe\\u7247',
  'interactionLedger.unit.second': '\\u79d2', 'interactionLedger.unit.byte': '\\u5b57\\u8282', 'interactionLedger.unit.provider-unit': '\\u4f9b\\u5e94\\u5546\\u5355\\u4f4d',
  'interactionLedger.unit.unknown': '\\u672a\\u77e5\\u5355\\u4f4d', 'interactionLedger.operation.read': '\\u8bfb\\u53d6',
  'interactionLedger.operation.create': '\\u521b\\u5efa', 'interactionLedger.operation.update': '\\u66f4\\u65b0',
  'interactionLedger.operation.delete': '\\u5220\\u9664', 'interactionLedger.operation.rename': '\\u91cd\\u547d\\u540d',
  'interactionLedger.operation.search': '\\u641c\\u7d22', 'interactionLedger.operation.execute-produced': '\\u6267\\u884c\\u4ea7\\u51fa',
  'interactionLedger.operation.unknown': '\\u672a\\u77e5\\u64cd\\u4f5c', 'interactionLedger.result.succeeded': '\\u6210\\u529f',
  'interactionLedger.result.failed': '\\u5931\\u8d25', 'interactionLedger.result.partial': '\\u90e8\\u5206\\u5b8c\\u6210',
  'interactionLedger.result.unknown': '\\u7ed3\\u679c\\u672a\\u77e5'
} as const

function decode(value: string): string {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
}

export default Object.fromEntries(
  Object.entries(escaped).map(([key, value]) => [key, decode(value)])
) as Record<keyof typeof escaped, string>
