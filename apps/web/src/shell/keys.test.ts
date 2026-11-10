import type { Call } from '@callfront/db/types'
import { describe, expect, it, vi } from 'vitest'
import { handleKey, type KeyContext } from './keys.ts'

const call = { id: 'c1' } as Call
const context = (over: Partial<KeyContext> = {}) => ({
  overlay: null, tab: 'you', searching: false, target: call, isCallOpen: false, open: vi.fn(), back: vi.fn(),
  closeOverlay: vi.fn(), openSearch: vi.fn(), closeSearch: vi.fn(), setTab: vi.fn(), step: vi.fn(), goChord: vi.fn(() => true),
  markDone: vi.fn(), markNotDone: vi.fn(), toggleUnread: vi.fn(), remove: vi.fn(), openRemind: vi.fn(), clearReminder: vi.fn(), undo: vi.fn(),
  ...over,
}) satisfies KeyContext
const press = (key: string, c: KeyContext, over: Partial<KeyboardEvent> & { tagName?: string; id?: string } = {}) =>
  handleKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: { tagName: over.tagName ?? 'BODY', id: over.id ?? '', blur: vi.fn() }, ...over } as unknown as KeyboardEvent, c)

describe('inbox keys', () => {
  it('moves with J, K and the arrows', () => {
    const c = context()
    for (const key of ['j', 'ArrowDown']) expect(press(key, c)).toBe(true)
    for (const key of ['k', 'ArrowUp']) press(key, c)
    expect(vi.mocked(c.step).mock.calls).toEqual([[1], [1], [-1], [-1]])
  })
  it('acts on the selected call', () => {
    const c = context()
    press('e', c); press('E', c); press('h', c); press('H', c); press('u', c); press('#', c)
    for (const fn of [c.markDone, c.markNotDone, c.openRemind, c.clearReminder, c.toggleUnread, c.remove]) expect(fn).toHaveBeenCalledExactlyOnceWith(call)
  })
  it('treats shift plus a letter as the capital, whatever the layout reports', () => {
    const c = context()
    press('e', c, { shiftKey: true })
    expect(c.markNotDone).toHaveBeenCalledWith(call)
    expect(c.markDone).not.toHaveBeenCalled()
  })
  it('does not delete on Backspace and does nothing without a selected call', () => {
    const c = context({ target: undefined })
    expect(press('Backspace', context())).toBe(false)
    expect(press('e', c)).toBe(false)
    expect(c.markDone).not.toHaveBeenCalled()
  })
  it('switches views with Tab and the number keys', () => {
    const c = context({ tab: 'spam' })
    press('Tab', c); press('Tab', c, { shiftKey: true }); press('4', c); press('5', c)
    expect(vi.mocked(c.setTab).mock.calls).toEqual([['you'], ['ai'], ['reminders'], ['done']])
  })
  it('leaves keys alone while typing, with a modifier or under an overlay', () => {
    const c = context()
    expect(press('e', c, { tagName: 'INPUT' })).toBe(false)
    expect(press('e', c, { metaKey: true })).toBe(false)
    expect(press('e', context({ overlay: 'remind' }))).toBe(false)
    expect(c.markDone).not.toHaveBeenCalled()
  })
  it('opens search with /, undoes with Z and starts a chord with G', () => {
    const c = context()
    press('/', c); press('z', c)
    expect(press('g', c)).toBe(true)
    press('h', c)
    expect(c.openSearch).toHaveBeenCalled()
    expect(c.undo).toHaveBeenCalled()
    expect(c.goChord).toHaveBeenCalledWith('h')
    expect(c.openRemind).not.toHaveBeenCalled() // the H belonged to the chord
  })
  it('closes things with Escape in order: overlay, search, mode', () => {
    const overlay = context({ overlay: 'remind' }), searching = context({ searching: true }), mode = context({ tab: 'done' })
    press('Escape', overlay); press('Escape', searching); press('Escape', mode)
    expect(overlay.closeOverlay).toHaveBeenCalled()
    expect(searching.closeSearch).toHaveBeenCalled()
    expect(mode.setTab).toHaveBeenCalledWith('you')
  })
})

describe('call view keys', () => {
  it('opens the selected call with Enter or O', () => {
    const c = context()
    press('Enter', c); press('o', c)
    expect(c.open).toHaveBeenCalledTimes(2)
  })
  it('steps with J and K but leaves the arrows for scrolling, and Escape goes back', () => {
    const c = context({ isCallOpen: true })
    press('j', c); press('k', c)
    expect(press('ArrowDown', c)).toBe(false)
    press('Escape', c)
    expect(vi.mocked(c.step).mock.calls).toEqual([[1], [-1]])
    expect(c.back).toHaveBeenCalled()
    expect(c.open).not.toHaveBeenCalled()
  })
  it('keeps the view while a call is open', () => {
    const c = context({ isCallOpen: true })
    press('2', c)
    expect(c.setTab).not.toHaveBeenCalled()
  })
})
