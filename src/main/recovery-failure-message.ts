import type { ClaudeResumeRecoveryFailureReason } from './resume-recovery-service'

const RECOVERY_FAILURE_MESSAGES: Record<ClaudeResumeRecoveryFailureReason, string> = {
  'session-id-mismatch': '备份中的会话 ID 与当前会话不一致，已停止以避免导入错误记录',
  'missing-source-path': '会话没有可定位的 Claude 源路径',
  'invalid-source-path': 'Claude 源路径格式无效，无法安全确定复活位置',
  'missing-backup': '找不到可用于复活的备份',
  'invalid-backup': '备份未通过严格 JSONL 校验，未写入 Claude 源目录',
  'remote-source-requires-explicit-target': '这是其他安装的会话，需要先选择要导入的 Claude 实例',
  'non-standard-source-requires-explicit-target': '源路径不是标准 Claude 目录，需要先明确选择导入目标',
  'target-instance-not-found': '找不到所选的 Claude 实例，请重新选择可用实例',
  'target-instance-unavailable': '目标 Claude 实例当前不可用，请确认该实例已安装且目录可访问',
  'target-instance-untrusted': '目标 Claude 实例未通过路径安全检查，已停止写入',
  'missing-target-inventory': '缺少目标实例的文件清单，无法排除覆盖风险',
  'target-inventory-incomplete': '目标实例文件清单不完整，无法安全复活',
  'target-instance-missing-config-dir': '目标 Claude 实例缺少配置目录，无法确定安全写入边界',
  'missing-local-device-id': '本机缺少设备标识，无法判断会话是否来自其他安装',
  'missing-local-username': '本机缺少用户名信息，无法安全判断旧版会话来源',
  'non-standard-target-refused': '所选目标不是受支持的 Claude 实例，已拒绝写入',
  'target-conflict': '目标 Claude 实例已有同名或同 ID 会话，已停止以避免覆盖',
  'source-not-claude': '此会话没有可复活到 Claude 的源记录',
  'unverified-backup': '备份缺少 SHA-256/大小证据，需要明确确认后才能复活',
  'materialization-failed': 'iCloud 备份尚未完整下载或完整性证据不匹配',
  'recovery-locked': '另一 Swob 进程正在复活该会话，请稍后重试',
  'post-publish-verification-failed': '目标已发布但最终校验失败，已保留现场且未自动删除',
  'io-error': '读取备份或写入目标时发生本地 I/O 错误，请检查磁盘和目录权限'
}

export function recoveryFailureMessage(reason: ClaudeResumeRecoveryFailureReason): string {
  return RECOVERY_FAILURE_MESSAGES[reason]
}
