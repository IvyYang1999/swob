/**
 * Electron + Playwright 启动辅助
 *
 * Playwright 可以直接启动 Electron 应用，拿到窗口对象，
 * 然后像操作网页一样操作 UI：点击、输入、拖拽、截图。
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import * as path from 'path'

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      // 可以设置测试专用的环境变量
      NODE_ENV: 'test'
    }
  })

  // 等待第一个窗口出现
  const page = await app.firstWindow()

  // 等待 React 渲染完成（侧边栏出现）
  await page.waitForLoadState('domcontentloaded')

  return { app, page }
}
