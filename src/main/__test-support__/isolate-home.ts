import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll } from 'vitest'

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-vitest-home-'))
process.env.HOME = isolatedHome
process.env.SWOB_TEST_HOME = isolatedHome
process.env.SWOB_LIBRARY_ROOT = path.join(isolatedHome, 'Library')
process.env.XDG_CACHE_HOME = path.join(isolatedHome, '.cache')
fs.mkdirSync(process.env.SWOB_LIBRARY_ROOT, { recursive: true })

afterAll(() => {
  fs.rmSync(isolatedHome, { recursive: true, force: true })
})
