import { describe, expect, test, vi } from 'vitest'
import { leaveInstallSetup } from './leave-install-setup.ts'

describe('leaveInstallSetup', () => {
  test('leaves at once while the save has not answered', () => {
    const save = vi.fn(() => new Promise<never>(() => {}))
    const onExit = vi.fn()
    leaveInstallSetup(save, { setAside: true }, onExit)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ setAside: true })
  })

  test('sends the save before it leaves', () => {
    const order: string[] = []
    leaveInstallSetup(
      async () => void order.push('save'),
      { finished: true },
      () => order.push('exit'),
    )
    expect(order).toEqual(['save', 'exit'])
  })
})
