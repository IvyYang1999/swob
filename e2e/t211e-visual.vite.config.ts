import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({ root: resolve(__dirname, '../src/renderer'), plugins: [react(), tailwindcss()] })
