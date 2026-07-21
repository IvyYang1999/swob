import { _electron as electron } from '@playwright/test'
import * as path from 'path'
async function main() {
  const app = await electron.launch({ args: [path.join(__dirname, '..', 'out', 'main', 'index.js')], env: { ...process.env, NODE_ENV: 'test' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(10000)
  const info = await page.evaluate(() => ({
    url: location.href,
    buttons: document.querySelectorAll('button').length,
    titles: [...document.querySelectorAll('button')].map(b => b.getAttribute('title')).filter(Boolean),
    bodyPreview: document.body.innerText.slice(0, 150)
  }))
  console.log('INFO:', JSON.stringify(info))
  await app.close()
  process.exit(0)
}
main()
