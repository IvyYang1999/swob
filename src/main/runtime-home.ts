import * as os from 'node:os'

interface ResolveRuntimeHomeOptions {
  platform: NodeJS.Platform
  nodeEnv?: string
  env: { HOME?: string; SWOB_TEST_HOME?: string; USERPROFILE?: string }
  osHome: string
}

export function resolveRuntimeHome(options: ResolveRuntimeHomeOptions): string {
  if (options.nodeEnv === 'test') {
    return options.env.HOME || options.env.SWOB_TEST_HOME || options.osHome
  }

  // os.homedir() implements native Windows USERPROFILE/profile rules. HOME is
  // deliberately ignored only on Windows because Git Bash can inject a path
  // that native Claude/Codex do not use. Other platforms retain prior behavior.
  if (options.platform === 'win32') return options.osHome
  return options.env.HOME || options.osHome
}

export function runtimeHome(): string {
  return resolveRuntimeHome({
    platform: process.platform,
    nodeEnv: process.env.NODE_ENV,
    env: process.env,
    osHome: os.homedir()
  })
}
