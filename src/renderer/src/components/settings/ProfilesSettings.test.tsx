/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ProfilesSettings } from './ProfilesSettings'

vi.mock('../../store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ locale: 'zh-CN' })
}))

const PROFILE = {
  id: 'p-1', name: '默认', provider: 'anthropic', model: 'claude-haiku-4-5', keyHint: '…abcd'
}

describe('ProfilesSettings', () => {
  afterEach(cleanup)
  beforeEach(() => {
    ;(window as any).api = {
      llmListProfiles: vi.fn().mockResolvedValue([PROFILE]),
      llmGetBindings: vi.fn().mockResolvedValue({ insights: 'p-1' }),
      llmSetBindings: vi.fn().mockResolvedValue({ insights: 'p-1', smartRename: 'p-1' }),
      llmSaveProfile: vi.fn().mockResolvedValue(true),
      llmDeleteProfile: vi.fn().mockResolvedValue(true)
    }
  })

  it('渲染 Profile 列表与四个功能绑定下拉', async () => {
    render(<ProfilesSettings />)
    expect((await screen.findAllByText('默认')).length).toBeGreaterThan(0)
    expect(screen.getByText(/anthropic · claude-haiku-4-5/)).toBeTruthy()
    for (const label of ['Insights 报告', '智能整理', '智能重命名']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(4)
    expect((selects[0] as HTMLSelectElement).value).toBe('p-1')
  })

  it('新增 Profile 走 llmSaveProfile,key 只在有输入时携带', async () => {
    render(<ProfilesSettings />)
    fireEvent.click(await screen.findByText('新增 Profile'))
    fireEvent.change(screen.getByPlaceholderText(/Profile 名称/), { target: { value: '备用' } })
    fireEvent.change(screen.getByPlaceholderText(/模型 ID/), { target: { value: 'gpt-5.4' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect((window as any).api.llmSaveProfile).toHaveBeenCalledWith({
        name: '备用', provider: 'anthropic', model: 'gpt-5.4'
      })
    })
  })

  it('改绑定调用 llmSetBindings 且保留其余绑定', async () => {
    render(<ProfilesSettings />)
    await screen.findAllByText('默认')
    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[2], { target: { value: 'p-1' } }) // 智能重命名
    await waitFor(() => {
      expect((window as any).api.llmSetBindings).toHaveBeenCalledWith({
        insights: 'p-1', smartRename: 'p-1'
      })
    })
  })

  it('删除前确认并提示 Keychain 同步清除', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ProfilesSettings />)
    await screen.findAllByText('默认')
    fireEvent.click(screen.getByTitle('删除'))
    await waitFor(() => {
      expect((window as any).api.llmDeleteProfile).toHaveBeenCalledWith('p-1')
    })
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Insights 报告|Keychain/)
    confirmSpy.mockRestore()
  })
})
