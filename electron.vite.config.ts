import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // The CLI is copied outside app.asar and runs under the system Node.
    // Every pure-JS runtime dependency reached by the standalone CLI must stay
    // bundled. Only native better-sqlite3 may rely on app.asar.unpacked.
    plugins: [externalizeDepsPlugin({ exclude: ['ajv', 'stream-json', 'stream-chain'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          cli: resolve(__dirname, 'src/cli/index.ts'),
          'library-worker': resolve(__dirname, 'src/main/library-worker.ts'),
          'summary-cache-migration-worker': resolve(
            __dirname,
            'src/main/summary-cache-migration-worker.cjs'
          ),
          'duplicate-recovery-worker': resolve(__dirname, 'src/main/duplicate-recovery-worker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
