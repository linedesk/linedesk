import type { Call } from '@callfront/db/types'
import { describe, expect, it, vi } from 'vitest'
import { handleKey, type KeyContext } from './keys.ts'

const call = { id: 'c1' } as Call
const context = (over: Partial<KeyContext> = {}) => ({
  overlay: null, tab: 'you', searching: false, target: call, isCallOpen: false, open: vi.fn(), back: vi.fn(),
  onInbox: true, navOpen: false, setOverlay: vi.fn(), setNavOpen: vi.fn(), openSearch: vi.fn(), closeSearch: vi.fn(), setTab: vi.fn(), step: vi.fn(), goChord: vi.fn(() => true),
  markDone: vi.fn(), markNotDone: vi.fn(), toggleUnread: vi.fn(), remove: vi.fn(), openRemind: vi.fn(), clearReminder: vi.fn(), undo: vi.fn(),
  ...over,
}) satisfies KeyContext
const press = (key: string, c: KeyContext, over: Partial<KeyboardEvent> & { tagName?: string; id?: string; type?: string } = {}) =>
  handleKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: { tagName: over.tagName ?? 'BODY', id: over.id ?? '', type: over.type ?? 'text', blur: vi.fn() }, ...over } as unknown as KeyboardEvent, c)

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
    expect(overlay.setOverlay).toHaveBeenCalledWith(null)
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

describe('shell keys', () => {
  it('toggles the command menu with ⌘K, even while typing', () => {
    const c = context()
    expect(press('k', c, { metaKey: true, tagName: 'INPUT' })).toBe(true)
    press('k', context({ overlay: 'commands', setOverlay: c.setOverlay }), { ctrlKey: true })
    expect(vi.mocked(c.setOverlay).mock.calls).toEqual([['commands'], [null]])
  })
  it('opens the shortcut sheet with ? and the menu with M, and Escape closes the menu first', () => {
    const c = context()
    press('?', c); press('m', c)
    expect(c.setOverlay).toHaveBeenCalledWith('help')
    expect(c.setNavOpen).toHaveBeenCalledWith(true)
  })
  it('closes the topmost layer first with Escape: the overlay, then the menu', () => {
    const both = context({ navOpen: true, overlay: 'commands' })
    press('Escape', both)
    expect(both.setOverlay).toHaveBeenCalledWith(null)
    expect(both.setNavOpen).not.toHaveBeenCalled()
    const menuOnly = context({ navOpen: true })
    press('Escape', menuOnly)
    expect(menuOnly.setNavOpen).toHaveBeenCalledWith(false)
  })
  it('keeps the keys working after ticking a checkbox', () => {
    const c = context({ isCallOpen: true })
    expect(press('e', c, { tagName: 'INPUT', type: 'checkbox' })).toBe(true)
    press('j', c, { tagName: 'INPUT', type: 'checkbox' })
    press('Escape', c, { tagName: 'INPUT', type: 'checkbox' })
    expect(c.markDone).toHaveBeenCalledWith(call)
    expect(c.step).toHaveBeenCalledWith(1)
    expect(c.back).toHaveBeenCalled() // one Escape, not two
  })
  it('uses Tab in the list only for the views, whatever has the focus, and blurs a clicked control', () => {
    const c = context()
    const blur = vi.fn()
    expect(press('Tab', c)).toBe(true)
    expect(press('Tab', c, { shiftKey: true })).toBe(true)
    expect(handleKey({ key: 'Tab', shiftKey: false, target: { tagName: 'BUTTON', blur } } as unknown as KeyboardEvent, c)).toBe(true)
    expect(vi.mocked(c.setTab).mock.calls).toEqual([['ai'], ['spam'], ['ai']])
    expect(blur).toHaveBeenCalled()
  })
  it('swallows Tab in an open call without doing anything', () => {
    const c = context({ isCallOpen: true })
    expect(press('Tab', c)).toBe(true)
    expect(press('Tab', c, { tagName: 'INPUT', type: 'checkbox' })).toBe(true)
    expect(c.setTab).not.toHaveBeenCalled()
  })
  it('leaves Tab to the browser in text fields, overlays, the menu and on other pages', () => {
    const c = context()
    expect(press('Tab', c, { tagName: 'INPUT' })).toBe(false)
    expect(press('Tab', c, { tagName: 'TEXTAREA' })).toBe(false)
    expect(press('Tab', context({ isCallOpen: true }), { tagName: 'INPUT' })).toBe(false)
    expect(press('Tab', context({ overlay: 'commands' }))).toBe(false)
    expect(press('Tab', context({ overlay: 'help' }))).toBe(false)
    expect(press('Tab', context({ navOpen: true }))).toBe(false)
    expect(press('Tab', context({ onInbox: false, target: undefined }))).toBe(false)
    expect(c.setTab).not.toHaveBeenCalled()
  })
  it('lets Enter activate a focused button instead of opening the selected call', () => {
    const c = context()
    expect(press('Enter', c, { tagName: 'BUTTON' })).toBe(false)
    expect(c.open).not.toHaveBeenCalled()
  })
  it('turns the inbox keys off on other pages', () => {
    const c = context({ onInbox: false, target: undefined })
    expect(press('j', c)).toBe(false)
    expect(press('1', c)).toBe(false)
    expect(c.step).not.toHaveBeenCalled()
    expect(c.setTab).not.toHaveBeenCalled()
  })
})
