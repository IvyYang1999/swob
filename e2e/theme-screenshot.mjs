import { _electron as electron } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-theme-shot-'))
const vaultRoot = path.join(fixtureHome, 'Documents', 'Swob')
fs.mkdirSync(vaultRoot, { recursive: true })
fs.mkdirSync(path.join(fixtureHome, '.claude-session-manager'), { recursive: true })
fs.writeFileSync(path.join(fixtureHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
  libraryPath: vaultRoot, onboardingCompleted: true
}))
fs.writeFileSync(path.join(vaultRoot, '.swob-config.json'), JSON.stringify({
  libraryRoot: vaultRoot,
  preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal', resumeTerminal: 'terminal-app', projectViewMode: 'folders' }
}, null, 2))

const app = await electron.launch({
  args: ['.'],
  cwd: '/private/tmp/swob-tf22v',
  env: { ...process.env, HOME: fixtureHome, NODE_ENV: 'development' },
})

const page = await app.firstWindow()
await page.setViewportSize({ width: 800, height: 700 })
await page.waitForTimeout(3000)

// Open settings
const settingsBtn = page.locator('[title*="设置"], [title*="Settings"]').first()
await settingsBtn.click()
await page.waitForTimeout(1000)

// Click 通用
const nav = page.getByRole('navigation', { name: /设置分类|Settings/ })
const generalBtn = nav.getByRole('button', { name: /通用|General/ })
await generalBtn.click()
await page.waitForTimeout(500)

// Scroll settings content to show theme area
const content = page.locator('[data-settings-category]')
await content.evaluate(el => el.scrollTop = 200)
await page.waitForTimeout(300)

const outDir = '/private/tmp/theme-screenshots'
fs.mkdirSync(outDir, { recursive: true })

await page.screenshot({ path: path.join(outDir, 'theme-picker-general.png') })
console.log('Screenshot saved: theme-picker-general.png')

await app.close()
fs.rmSync(fixtureHome, { recursive: true, force: true })
console.log('Done')
