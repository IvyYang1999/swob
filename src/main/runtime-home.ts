import * as os from 'node:os'

export function runtimeHome(): string {
  if (process.env.NODE_ENV === 'test') {
    return process.env.HOME || process.env.SWOB_TEST_HOME || os.homedir()
  }
  return os.homedir()
}
