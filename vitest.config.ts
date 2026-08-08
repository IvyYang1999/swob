import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: [
      './src/main/__test-support__/isolate-home.ts',
      './src/main/__test-support__/jsdom-storage-shim.ts'
    ],
    exclude: ['e2e/**', 'node_modules/**', 'out/**', 'dist/**', '.claude/**']
  }
})
