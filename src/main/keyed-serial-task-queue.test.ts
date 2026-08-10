import { describe, expect, it, vi } from 'vitest'
import { KeyedSerialTaskQueue } from './keyed-serial-task-queue'

describe('KeyedSerialTaskQueue', () => {
  it('singleflights the same key', async () => {
    const queue = new KeyedSerialTaskQueue<string, string>()
    const task = vi.fn(async () => 'A')
    const first = queue.run('a', task)
    const second = queue.run('a', task)
    expect(first).toBe(second)
    await expect(first).resolves.toBe('A')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('serializes different keys and preserves each result', async () => {
    const queue = new KeyedSerialTaskQueue<string, string>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = queue.run('a', async () => {
      order.push('a:start')
      await gate
      order.push('a:end')
      return 'A'
    })
    const second = queue.run('b', async () => {
      order.push('b:start')
      return 'B'
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    release()
    await expect(Promise.all([first, second])).resolves.toEqual(['A', 'B'])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('continues after a failed task', async () => {
    const queue = new KeyedSerialTaskQueue<string, string>()
    const first = queue.run('a', async () => { throw new Error('failed') })
    const second = queue.run('b', async () => 'B')
    await expect(first).rejects.toThrow('failed')
    await expect(second).resolves.toBe('B')
  })
})
