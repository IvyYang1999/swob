export function assertRegisteredResumeProtocol(
  protocol: string,
  handler: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin' && platform !== 'win32') return

  const client = protocol === 'codex:'
    ? 'Codex/ChatGPT'
    : protocol === 'claude:'
      ? 'Claude'
      : 'ZCode'
  if (!handler.trim()) {
    throw new Error(`未检测到可处理 ${protocol} 的 ${client} App`)
  }

  const expectedHandler = protocol === 'codex:'
    ? platform === 'win32'
      // Electron documents that the returned display-name format is not stable;
      // Windows may include an .exe suffix while still naming the same client.
      ? /^(Codex|ChatGPT)(?:\.exe)?$/i
      : /^(Codex|ChatGPT)$/i
    : protocol === 'claude:'
      ? /^Claude$/i
      : /^ZCode$/i
  if (!expectedHandler.test(handler.trim())) {
    throw new Error(`${protocol} 当前由非官方应用“${handler}”处理，已拒绝打开`)
  }
}
