// The keyboard model: one handler for the whole app. Everything it does is also reachable
// with the mouse; the handler only maps keys to the same commands.
import type { Call } from '@linedesk/db/types'
import { SEARCH_INPUT_ID } from '../inbox/InboxHead.tsx'
import { type InboxTab, splits, viewByKey } from '../inbox-model.ts'
import { openReport } from '../feedback/report.ts'

/** `pick`: a pick list such as the member picker (A). */
export type Overlay = 'remind' | 'commands' | 'pick' | 'help' | null

export type KeyContext = {
  overlay: Overlay
  setOverlay: (overlay: Overlay) => void
  /** False on pages other than the inbox: call and list keys are off there. */
  onInbox: boolean
  navOpen: boolean
  setNavOpen: (open: boolean) => void
  tab: InboxTab
  /** The views Tab cycles through right now (visibleSplits: Spam only while there is a spam call). */
  views: readonly InboxTab[]
  searching: boolean
  /** The open call, else the call under the cursor. */
  target: Call | undefined
  isCallOpen: boolean
  open: (call: Call) => void
  back: () => void
  openSearch: () => void
  closeSearch: () => void
  setTab: (tab: InboxTab) => void
  step: (by: number) => void
  goChord: (key: string) => boolean
  /** Play or pause the open call's recording; false when there is none on screen. */
  togglePlayback: () => boolean
  /** I in an open call: show or hide the contact panel; false when there is none. */
  toggleContactPanel: () => boolean
  /** L and ⇧T in an open live call: listen, stop listening, take over; false when not handled. */
  liveCallKey: (key: string) => boolean
  markDone: (call: Call) => void
  markNotDone: (call: Call) => void
  toggleUnread: (call: Call) => void
  remove: (call: Call) => void
  /** ! files the call as spam, or takes a spam call back to Needs you. */
  toggleSpam: (call: Call) => void
  /** ⇧B blocks the caller's number (and files the call in Spam), or unblocks it. */
  toggleBlock: (call: Call) => void
  /** A: pick who the call goes to (only while the workspace has more than one member). */
  openAssign: (call: Call) => void
  canAssign: boolean
  openRemind: (call: Call) => void
  clearReminder: (call: Call) => void
  undo: () => void
  /** Calls picked for a bulk action; call keys then apply to all of them. */
  selectionCount: number
  toggleSelect: (call: Call) => void
  /** ⇧J / ⇧K: add the cursor's call and the next one to the selection. */
  extendSelect: (by: number) => void
  selectAll: () => void
  clearSelection: () => void
}

/** A page other than the inbox can take the list keys (J, K, arrows, Enter, O, /, Esc) while it is shown. Returns true when it handled the key. */
export type PageKeys = (key: string) => boolean
let pageKeys: PageKeys | null = null
export function setPageKeys(handler: PageKeys | null) {
  pageKeys = handler
}

/** Keys that may repeat while held: moving through lists and views. */
const REPEATING_KEYS = new Set(['j', 'k', 'J', 'K', 'ArrowDown', 'ArrowUp', 'Tab'])

const CHORD_MS = 1200
let chordUntil = 0

/** Enter or Space on a focused button, link or checkbox activates that control, not the app's shortcut. */
const activatesControl = (key: string, el: HTMLElement) =>
  (key === 'Enter' && /^(BUTTON|A)$/.test(el.tagName)) || (key === ' ' && /^(BUTTON|A|INPUT)$/.test(el.tagName))

const NOT_TEXT_INPUTS = /^(checkbox|radio|button|submit|reset|range|file|color|image)$/

/** True while the focus is where keys are text: text inputs, text areas, selects. A ticked checkbox is not typing. */
function isTyping(el: HTMLElement): boolean {
  if (el.tagName === 'INPUT') return !NOT_TEXT_INPUTS.test((el as HTMLInputElement).type)
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable
}

function onEscape(el: HTMLElement, c: KeyContext) {
  if (c.overlay) return c.setOverlay(null) // the topmost layer first
  if (c.navOpen) return c.setNavOpen(false)
  if (el.id === SEARCH_INPUT_ID) {
    el.blur()
    return c.closeSearch()
  }
  if (isTyping(el)) {
    el.blur()
    // A field in a side panel that closes with Esc (contacts): one Esc leaves the field and closes the panel.
    if (!c.onInbox && el.closest('[data-esc-closes]')) pageKeys?.('Escape')
    return
  }
  if (!c.onInbox) return void pageKeys?.('Escape')
  if (c.isCallOpen) return c.back()
  // A control in the list has the focus (a view clicked with the mouse): Esc also hands the focus back to the list,
  // so Tab switches views again (tabSwitchesViews).
  if (!tabSwitchesViews(el)) el.blur()
  if (c.selectionCount) return c.clearSelection()
  if (c.searching) return c.closeSearch()
  if (!splits.includes(c.tab as never)) c.setTab('you')
}

function nextView(tab: InboxTab, back: boolean, views: readonly InboxTab[]): InboxTab {
  const i = views.indexOf(tab)
  return i < 0 ? 'you' : views[(i + (back ? -1 : 1) + views.length) % views.length]!
}

/** Keys that act on the selected call. Returns false when the key is not one of them. */
function onCallKey(key: string, call: Call, c: KeyContext): boolean {
  const run: Record<string, (call: Call) => void> = {
    e: c.markDone,
    E: c.markNotDone,
    h: c.openRemind,
    H: c.clearReminder,
    u: c.toggleUnread,
    '#': c.remove,
    '!': c.toggleSpam,
    B: c.toggleBlock,
    ...(c.canAssign ? { a: c.openAssign } : {}),
  }
  if (!run[key]) return false
  run[key](call)
  return true
}

/**
 * Tab switches the inbox views only while nothing has the focus (the page body: the list moves with J and K and never
 * takes it). Once the focus is on a control (a field, a button, a menu, a dialog, a tab clicked with the mouse), Tab is
 * the browser's and walks the focus, so keyboard users reach every control (Janik, Q11 (c)). Also the browser's in an
 * open call and on every other page. ⇧Tab mirrors it.
 */
export const tabSwitchesViews = (el: Element | null) => !el || el.tagName === 'BODY' || el.tagName === 'HTML'

function onInboxTab(el: HTMLElement, back: boolean, c: KeyContext): boolean {
  if (c.isCallOpen || !tabSwitchesViews(el)) return false
  c.setTab(nextView(c.tab, back, c.views))
  return true
}

/** List and view keys of the inbox. Returns false when the key is not one of them. */
function onInboxKey(k: string, c: KeyContext): boolean {
  if ((k === 'J' || k === 'K') && !c.isCallOpen) c.extendSelect(k === 'J' ? 1 : -1)
  else if (k === 'j' || k === 'J') c.step(1)
  else if (k === 'k' || k === 'K') c.step(-1)
  else if (k === 'x' && !c.isCallOpen && c.target) c.toggleSelect(c.target)
  else if ((k === 'ArrowDown' || k === 'ArrowUp') && !c.isCallOpen)
    c.step(k === 'ArrowDown' ? 1 : -1) // arrows scroll an open call
  else if ((k === 'Enter' || k === 'o') && !c.isCallOpen && c.target) c.open(c.target)
  else if (viewByKey[k] && !c.isCallOpen) c.setTab(viewByKey[k])
  else return c.target ? onCallKey(k, c.target, c) : false
  return true
}

/** Returns true when the key was handled (the caller prevents the default). */
export function handleKey(e: KeyboardEvent, c: KeyContext): boolean {
  const el = e.target as HTMLElement
  const k = e.shiftKey && e.key.length === 1 ? e.key.toUpperCase() : e.key // ⇧E is 'E' whatever the layout reports
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'k') {
    c.setOverlay(c.overlay === 'commands' ? null : 'commands')
    return true
  }
  if (k === 'Escape') {
    onEscape(el, c)
    return false
  }
  // ⌘A on the list selects every call in the view (in text fields it stays the browser's select-all).
  if (
    (e.metaKey || e.ctrlKey) &&
    k.toLowerCase() === 'a' &&
    c.onInbox &&
    !c.isCallOpen &&
    !c.overlay &&
    !c.navOpen &&
    !isTyping(el)
  ) {
    c.selectAll()
    return true
  }
  if (c.overlay) {
    if (c.overlay === 'help' && k === '?' && !isTyping(el)) c.setOverlay(null)
    return false
  }
  if (isTyping(el) || activatesControl(k, el) || e.metaKey || e.ctrlKey || e.altKey) return false
  // A held key repeats only moves (J, K, arrows, Tab). Every other shortcut acts once per press: holding
  // Z, E or the picker's key must not fire it dozens of times (undo flipping a call back and forth).
  if (e.repeat && !REPEATING_KEYS.has(k)) return true
  // ⇧R and ⇧F: Help › Report a bug, Request a feature, from every page (also with the navigation open).
  if ((k === 'R' || k === 'F') && Date.now() >= chordUntil) {
    if (c.navOpen) c.setNavOpen(false)
    openReport(k === 'R' ? 'bug' : 'feature')
    return true
  }
  // The open navigation is the topmost layer: list and call keys stay with it (it has its own arrows and Tab).
  if (c.navOpen) {
    if (k === 'm' || k === 'M') c.setNavOpen(false)
    else if (k === '?') c.setOverlay('help')
    else return false
    return true
  }
  if (k === 'Tab') return c.onInbox && !c.navOpen && onInboxTab(el, e.shiftKey, c)
  if (Date.now() < chordUntil) {
    chordUntil = 0
    return c.goChord(k.toLowerCase())
  }
  if (k === 'g' || k === 'G') {
    chordUntil = Date.now() + CHORD_MS
    return true
  }
  if (k === '?') c.setOverlay('help')
  else if (k === 'm' || k === 'M') c.setNavOpen(!c.navOpen)
  else if (k === '/') {
    if (c.onInbox || !pageKeys?.('/')) c.openSearch()
  } else if (k === 'z') c.undo()
  else if (k === ' ') return c.onInbox && c.isCallOpen && c.togglePlayback()
  else if (k === 'i' && c.onInbox && c.isCallOpen) return c.toggleContactPanel()
  else if ((k === 'l' || k === 'T') && c.onInbox && c.isCallOpen && c.liveCallKey(k)) return true
  else return c.onInbox ? onInboxKey(k, c) : !!pageKeys?.(k)
  return true
}
