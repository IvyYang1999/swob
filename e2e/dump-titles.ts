import { closeApp, launchApp } from './helpers'
async function main() {
  const launched = await launchApp()
  const { page } = launched
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(10000)
  const info = await page.evaluate(() => ({
    url: location.href,
    buttons: document.querySelectorAll('button').length,
    titles: [...document.querySelectorAll('button')].map(b => b.getAttribute('title')).filter(Boolean),
    bodyPreview: document.body.innerText.slice(0, 150)
  }))
  console.log('INFO:', JSON.stringify(info))
  await closeApp(launched)
  process.exit(0)
}
main()
