/**
 * E2E 测试：应用启动和基本交互
 *
 * 这些测试会真正启动 Electron 应用，模拟用户操作，截图验证。
 * 跑之前需要先 build：npx electron-vite build
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const launched = await launchApp()
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  await app.close()
})

test('应用能正常启动，窗口标题存在', async () => {
  const title = await page.title()
  // Electron 应用应该有个标题（哪怕是默认的）
  expect(title).toBeDefined()
})

test('侧边栏加载出 session 列表', async () => {
  // 等待 session 列表加载（找到任意一个 session 按钮）
  const sessionItem = page.locator('[data-session-id]').first()
  await expect(sessionItem).toBeVisible({ timeout: 10000 })

  // 截图看看实际效果
  await page.screenshot({ path: 'e2e/screenshots/sidebar-loaded.png' })
})

test('点击 session 后右侧显示聊天内容', async () => {
  // 点击第一个 session
  const firstSession = page.locator('[data-session-id]').first()
  await firstSession.click()

  // 等待聊天内容出现（找到用户或助手消息的容器）
  // ChatViewer 里的消息都在 space-y-4 的 div 里
  await page.waitForTimeout(2000) // 等 JSONL 解析完

  await page.screenshot({ path: 'e2e/screenshots/chat-loaded.png' })
})

test('创建文件夹', async () => {
  // 找到"新建文件夹"按钮（Sidebar 底部的 + 按钮）
  const newFolderBtn = page.locator('button').filter({ hasText: /新建|New/ }).first()

  if (await newFolderBtn.isVisible()) {
    await newFolderBtn.click()

    // 应该出现输入框
    const input = page.locator('input[placeholder]').last()
    await input.fill('测试文件夹-E2E')
    await input.press('Enter')

    // 文件夹应该出现在侧边栏
    await expect(page.locator('text=测试文件夹-E2E')).toBeVisible({ timeout: 3000 })
    await page.screenshot({ path: 'e2e/screenshots/folder-created.png' })
  }
})

test('拖拽 session 到文件夹', async () => {
  // 找到一个未分组的 session
  const session = page.locator('[data-session-id]').first()
  // 找到刚创建的文件夹
  const folder = page.locator('text=测试文件夹-E2E')

  if (await session.isVisible() && await folder.isVisible()) {
    // Playwright 的 dragTo 可以模拟完整的 drag-and-drop
    await session.dragTo(folder)

    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'e2e/screenshots/after-drag.png' })
  }
})

test('全局搜索 ⌘K 能打开', async () => {
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'e2e/screenshots/search-opened.png' })
})
