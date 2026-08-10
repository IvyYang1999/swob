import { defineConfig } from '@playwright/test'
import {
  clearE2EProviderHomeOverrides,
  E2E_CLEARED_PROVIDER_HOME_OVERRIDES
} from './e2e/provider-home-isolation'

// Any Electron process launched from Playwright inherits this fail-closed marker.
// A direct launcher that omits the explicit sandbox paths will terminate at startup.
process.env.SWOB_E2E_RUNNER = '1'
const previouslyClearedProviderHomeOverrides = (
  process.env[E2E_CLEARED_PROVIDER_HOME_OVERRIDES] || ''
).split(',').filter(Boolean)
const clearedProviderHomeOverrides = clearE2EProviderHomeOverrides(process.env)
const allClearedProviderHomeOverrides = [
  ...new Set([...previouslyClearedProviderHomeOverrides, ...clearedProviderHomeOverrides])
]
if (allClearedProviderHomeOverrides.length > 0) {
  process.env[E2E_CLEARED_PROVIDER_HOME_OVERRIDES] = allClearedProviderHomeOverrides.join(',')
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  workers: 1,
  webServer: {
    command: 'npx vite --config e2e/t211e-visual.vite.config.ts --host 127.0.0.1 --port 4179',
    url: 'http://127.0.0.1:4179/catalog-visual.html',
    reuseExistingServer: false
  },
  use: {
    trace: 'on-first-retry'
  }
})
