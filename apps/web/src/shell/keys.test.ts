import type { Call } from '@linedesk/db/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleKey, setPageKeys, type KeyContext } from './keys.ts'

const call = { id: 'c1' } as Call
const context = (over: Partial<KeyContext> = {}) =>
  ({
    overlay: null,
    tab: 'you',
    searching: false,
    target: call,
    isCallOpen: false,
    open: vi.fn(),
    back: vi.fn(),
    onInbox: true,
    navOpen: false,
    setOverlay: vi.fn(),
    setNavOpen: vi.fn(),
    togglePlayback: vi.fn(() => true),
    toggleContactPanel: vi.fn(() => true),
    liveCallKey: vi.fn(() => false),
    openSearch: vi.fn(),
    closeSearch: vi.fn(),
    setTab: vi.fn(),
    step: vi.fn(),
    goChord: vi.fn(() => true),
    markDone: vi.fn(),
    markNotDone: vi.fn(),
    toggleUnread: vi.fn(),
    remove: vi.fn(),
    toggleSpam: vi.fn(),
    toggleBlock: vi.fn(),
    openAssign: vi.fn(),
    canAssign: true,
    openRemind: vi.fn(),
    clearReminder: vi.fn(),
    undo: vi.fn(),
    selectionCount: 0,
    toggleSelect: vi.fn(),
    extendSelect: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    ...over,
  }) satisfies KeyContext
const press = (
  key: string,
  c: KeyContext,
  over: Partial<KeyboardEvent> & { tagName?: string; id?: string; type?: string } = {},
) =>
  handleKey(
    {
      key,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: { tagName: over.tagName ?? 'BODY', id: over.id ?? '', type: over.type ?? 'text', blur: vi.fn() },
      ...over,
    } as unknown as KeyboardEvent,
    c,
  )

describe('inbox keys', () => {
  it('moves with J, K and the arrows', () => {
    const c = context()
    for (const key of ['j', 'ArrowDown']) expect(press(key, c)).toBe(true)
    for (const key of ['k', 'ArrowUp']) press(key, c)
    expect(vi.mocked(c.step).mock.calls).toEqual([[1], [1], [-1], [-1]])
  })
  it('acts on the selected call', () => {
    const c = context()
    press('e', c)
    press('E', c)
    press('h', c)
    press('H', c)
    press('u', c)
    press('#', c)
    press('!', c, { shiftKey: true })
    press('b', c, { shiftKey: true })
    for (const fn of [
      c.markDone,
      c.markNotDone,
      c.openRemind,
      c.clearReminder,
      c.toggleUnread,
      c.remove,
      c.toggleSpam,
      c.toggleBlock,
    ])
      expect(fn).toHaveBeenCalledExactlyOnceWith(call)
  })
  it('toggles the contact panel with I in an open call only', () => {
    const open = context({ isCallOpen: true })
    expect(press('i', open)).toBe(true)
    expect(open.toggleContactPanel).toHaveBeenCalledOnce()
    const list = context()
    press('i', list)
    expect(list.toggleContactPanel).not.toHaveBeenCalled()
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
    press('Tab', c)
    press('Tab', c, { shiftKey: true })
    press('4', c)
    press('5', c)
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
    press('/', c)
    press('z', c)
    expect(press('g', c)).toBe(true)
    press('h', c)
    expect(c.openSearch).toHaveBeenCalled()
    expect(c.undo).toHaveBeenCalled()
    expect(c.goChord).toHaveBeenCalledWith('h')
    expect(c.openRemind).not.toHaveBeenCalled() // the H belonged to the chord
  })
  it('closes things with Escape in order: overlay, search, mode', () => {
    const overlay = context({ overlay: 'remind' }),
      searching = context({ searching: true }),
      mode = context({ tab: 'done' })
    press('Escape', overlay)
    press('Escape', searching)
    press('Escape', mode)
    expect(overlay.setOverlay).toHaveBeenCalledWith(null)
    expect(searching.closeSearch).toHaveBeenCalled()
    expect(mode.setTab).toHaveBeenCalledWith('you')
  })
})

describe('call view keys', () => {
  it('opens the selected call with Enter or O', () => {
    const c = context()
    press('Enter', c)
    press('o', c)
    expect(c.open).toHaveBeenCalledTimes(2)
  })
  it('steps with J and K but leaves the arrows for scrolling, and Escape goes back', () => {
    const c = context({ isCallOpen: true })
    press('j', c)
    press('k', c)
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
    press('?', c)
    press('m', c)
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
    expect(
      handleKey({ key: 'Tab', shiftKey: false, target: { tagName: 'BUTTON', blur } } as unknown as KeyboardEvent, c),
    ).toBe(true)
    expect(vi.mocked(c.setTab).mock.calls).toEqual([['ai'], ['spam'], ['ai']])
    expect(blur).toHaveBeenCalled()
  })
  it('leaves Tab to the browser in an open call, so next steps, caller fields and previous calls are reachable', () => {
    const c = context({ isCallOpen: true })
    expect(press('Tab', c)).toBe(false)
    expect(press('Tab', c, { shiftKey: true })).toBe(false)
    expect(press('Tab', c, { tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(press('Tab', c, { tagName: 'BUTTON' })).toBe(false)
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

describe('recording keys', () => {
  it('toggles playback with Space in an open call', () => {
    const c = context({ isCallOpen: true })
    expect(press(' ', c)).toBe(true)
    expect(c.togglePlayback).toHaveBeenCalledOnce()
  })
  it('leaves Space alone without a recording, in the list, in fields and on focused controls', () => {
    expect(press(' ', context({ isCallOpen: true, togglePlayback: vi.fn(() => false) }))).toBe(false)
    const c = context({ isCallOpen: true })
    expect(press(' ', context())).toBe(false)
    expect(press(' ', c, { tagName: 'TEXTAREA' })).toBe(false)
    expect(press(' ', c, { tagName: 'BUTTON' })).toBe(false)
    expect(press(' ', c, { tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(c.togglePlayback).not.toHaveBeenCalled()
  })
})

describe('topmost layer', () => {
  it('keeps list and call keys away from the list while the navigation is open', () => {
    const c = context({ navOpen: true })
    for (const key of ['j', 'k', 'e', 'E', 'h', 'u', '#', 'Enter', 'Tab', '1', '/', 'z'])
      expect(press(key, c)).toBe(false)
    expect(c.step).not.toHaveBeenCalled()
    expect(c.markDone).not.toHaveBeenCalled()
    expect(c.open).not.toHaveBeenCalled()
    expect(c.setTab).not.toHaveBeenCalled()
    press('m', c)
    expect(c.setNavOpen).toHaveBeenCalledWith(false)
  })
  it("lets you type ? in the shortcut sheet's search field", () => {
    const c = context({ overlay: 'help' })
    expect(press('?', c, { tagName: 'INPUT' })).toBe(false)
    expect(c.setOverlay).not.toHaveBeenCalled()
    press('?', c)
    expect(c.setOverlay).toHaveBeenCalledWith(null)
  })
})

describe('page keys', () => {
  afterEach(() => setPageKeys(null))
  it('hands list keys, / and Esc to the page that registered for them', () => {
    const page = vi.fn((key: string) => key !== 'x')
    setPageKeys(page)
    const c = context({ onInbox: false, target: undefined })
    expect(press('j', c)).toBe(true)
    expect(press('Enter', c)).toBe(true)
    expect(press('/', c)).toBe(true)
    press('Escape', c)
    expect(press('x', c)).toBe(false)
    expect(page.mock.calls.map(([key]) => key)).toEqual(['j', 'Enter', '/', 'Escape', 'x'])
    expect(c.openSearch).not.toHaveBeenCalled()
    expect(c.step).not.toHaveBeenCalled()
  })
  it('one Esc in a field of a panel that closes with Esc blurs the field and closes the panel', () => {
    const page = vi.fn(() => true)
    setPageKeys(page)
    const blur = vi.fn()
    const field = (inPanel: boolean) =>
      ({ tagName: 'INPUT', id: '', type: 'text', blur, closest: () => (inPanel ? {} : null) }) as unknown as EventTarget
    press('Escape', context({ onInbox: false }), { target: field(true) })
    expect(blur).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledWith('Escape')
    page.mockClear()
    press('Escape', context({ onInbox: false }), { target: field(false) })
    expect(blur).toHaveBeenCalledTimes(2)
    expect(page).not.toHaveBeenCalled()
  })
  it('keeps / as call search on pages that do not take it, and leaves the inbox alone', () => {
    setPageKeys(() => false)
    const page = context({ onInbox: false })
    press('/', page)
    expect(page.openSearch).toHaveBeenCalled()
    const inbox = context()
    press('j', inbox)
    expect(inbox.step).toHaveBeenCalledWith(1)
  })
  it('does not reach the page while typing or with an overlay open', () => {
    const page = vi.fn(() => true)
    setPageKeys(page)
    press('j', context({ onInbox: false }), { tagName: 'INPUT' })
    press('j', context({ onInbox: false, overlay: 'help' }))
    expect(page).not.toHaveBeenCalled()
  })
})

describe('selection', () => {
  it('picks the cursor call with X and extends with shift J and K', () => {
    const c = context()
    press('x', c)
    expect(c.toggleSelect).toHaveBeenCalledWith(call)
    press('j', c, { shiftKey: true })
    press('k', c, { shiftKey: true })
    expect(vi.mocked(c.extendSelect).mock.calls).toEqual([[1], [-1]])
    expect(c.step).not.toHaveBeenCalled()
  })
  it('selects every call with cmd A, but not while typing or with a call open', () => {
    const c = context()
    expect(press('a', c, { metaKey: true })).toBe(true)
    press('a', c, { metaKey: true, tagName: 'INPUT' })
    press('a', context({ isCallOpen: true }), { metaKey: true })
    expect(c.selectAll).toHaveBeenCalledTimes(1)
  })
  it('clears the selection with Esc before leaving the view', () => {
    const c = context({ selectionCount: 3, tab: 'done' })
    press('Escape', c)
    expect(c.clearSelection).toHaveBeenCalled()
    expect(c.setTab).not.toHaveBeenCalled()
  })
})
