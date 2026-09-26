import { defineConfig } from 'vitest/config'
import { swobCoreSourceAliases } from './packages/core/source-aliases'

export default defineConfig({
  resolve: {
    alias: swobCoreSourceAliases()
  },
  test: {
    setupFiles: [
      './src/main/__test-support__/isolate-home.ts',
      './src/main/__test-support__/jsdom-storage-shim.ts'
    ],
    exclude: ['e2e/**', 'node_modules/**', 'out/**', 'dist/**', 'packages/*/dist/**', '.claude/**']
  }
})
