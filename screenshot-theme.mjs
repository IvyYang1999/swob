import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })

// Connect to the Electron renderer dev server
await page.goto('http://localhost:5173/')
await page.waitForTimeout(3000)

// Click settings button (gear icon in toolbar)
const settingsBtn = page.locator('[aria-label*="设置"], [aria-label*="Settings"], [title*="设置"]').first()
if (await settingsBtn.count() > 0) {
  await settingsBtn.click()
  await page.waitForTimeout(1000)
} else {
  // Try keyboard shortcut
  await page.keyboard.press('Meta+,')
  await page.waitForTimeout(1000)
}

// Click "通用" / "General" nav button
const generalBtn = page.locator('nav button:has-text("通用"), nav button:has-text("General")').first()
if (await generalBtn.count() > 0) {
  await generalBtn.click()
  await page.waitForTimeout(500)
}

// Scroll down to theme area if needed
const settingsContent = page.locator('[data-settings-category]')
if (await settingsContent.count() > 0) {
  await settingsContent.evaluate(el => el.scrollTop = 300)
  await page.waitForTimeout(300)
}

await page.screenshot({ path: '/private/tmp/theme-picker-screenshot.png', fullPage: false })
console.log('Screenshot saved to /private/tmp/theme-picker-screenshot.png')

await browser.close()
