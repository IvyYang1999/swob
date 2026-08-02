import { defineConfig } from '@playwright/test'

// Any Electron process launched from Playwright inherits this fail-closed marker.
// A direct launcher that omits the explicit sandbox paths will terminate at startup.
process.env.SWOB_E2E_RUNNER = '1'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    trace: 'on-first-retry'
  }
})
