// The first-use tour without React: its steps and whether it is due. It is queued when onboarding ends
// (when the install offers it, FIRST_USE) and starts once, the first time the inbox shows a call (real or
// sample): right after onboarding the go-live checklist comes first, and a tour of an empty inbox has
// nothing to point at. ⌘K "Show the tour" starts it any time. Kept in this browser only: a convenience,
// not a record.
import { i18n } from '../i18n/index.tsx'
import { readStored, writeStored } from '../safeStorage.ts'

export type TourPlacement = 'top' | 'bottom' | 'bottom-start' | 'bottom-end'

export type TourStep = {
  title: string
  /** The job this step teaches, in plain words: what to do, not which key does it. */
  text: string
  /** The keys for it, one small grey line under the text; left out on touch screens (no keyboard to press them on). */
  keys?: string
  /**
   * CSS selectors of what the step points at, the first one that is on screen wins. The step's card sits
   * next to it with an arrow and the rest of the screen dims; with none on screen the card is centred.
   */
  targets?: string[]
  /** Preferred side of the target; the card flips to the other side when there is no room. */
  placement?: TourPlacement
}

const CURSOR_ROW = '.ib-list .row.is-cursor'
const FIRST_ROW = '.ib-list .row'

/**
 * Four steps, each about the job (where calls land, what a call holds, handling it, where the rest is); the keys
 * come second, in one quiet line per step.
 * `canAssign`: the workspace has someone else to assign calls to; alone, A does nothing, so the tour skips it.
 * `samples`: the inbox shows sample calls, which the tour's end removes; its last step says so.
 */
export function tourSteps(assistant: string, canAssign = true, samples = false): TourStep[] {
  const { t } = i18n()
  return [
    {
      title: t('shell.tour.inbox.title'),
      text: t('shell.tour.inbox.job', { assistant }),
      keys: t('shell.tour.inbox.keys', { down: 'J', up: 'K' }),
      targets: [FIRST_ROW],
      placement: 'bottom',
    },
    {
      title: t('shell.tour.call.title'),
      text: t('shell.tour.call.job'),
      keys: t('shell.tour.call.keys', { open: 'Enter', back: 'Esc' }),
      targets: [CURSOR_ROW, FIRST_ROW],
      placement: 'bottom',
    },
    {
      title: t('shell.tour.handle.title'),
      text: canAssign ? t('shell.tour.handle.jobAssign') : t('shell.tour.handle.job'),
      keys: canAssign
        ? t('shell.tour.handle.keysAssign', { callBack: 'C', done: 'E', remind: 'H', assign: 'A', undo: 'Z' })
        : t('shell.tour.handle.keys', { callBack: 'C', done: 'E', remind: 'H', undo: 'Z' }),
      targets: [`${CURSOR_ROW} .r-acts`, CURSOR_ROW, FIRST_ROW],
      placement: 'bottom-end',
    },
    {
      title: t('shell.tour.rest.title'),
      text: t(samples ? 'shell.tour.rest.jobSamples' : 'shell.tour.rest.job'),
      keys: t('shell.tour.rest.keys', { commands: '⌘K', shortcuts: '?' }),
      targets: ['.menu-btn'], // the menu: the assistant, contacts, settings
      placement: 'bottom-start',
    },
  ]
}

const PENDING_KEY = 'linedesk.tour.pending'

// Private windows: the tour then just does not come back on its own.
const read = (key: string) => readStored('local', key)
const write = (key: string, value: string | null) => writeStored('local', key, value)

/** Onboarding just finished in this browser for `workspaceId`: the tour starts in its inbox. */
export const queueTour = (workspaceId: string) => write(PENDING_KEY, workspaceId)
export const tourDue = (workspaceId: string) => read(PENDING_KEY) === workspaceId
/** Done or dismissed: it does not start again on its own. */
export const finishTour = () => write(PENDING_KEY, null)

/**
 * Whether the queued tour starts now: the inbox list is on screen with at least one call in it. Until then it
 * stays queued; once started it is finished (finishTour), so it starts only once.
 */
export const tourStartsNow = (workspaceId: string, inboxCalls: number) => inboxCalls > 0 && tourDue(workspaceId)

/** The next step for a key, or 'close'; null for keys the tour leaves to the app. */
export function tourKey(key: string, at: number, count: number): number | 'close' | null {
  if (key === 'Escape') return 'close'
  if (key === 'ArrowRight') return at + 1 >= count ? 'close' : at + 1
  if (key === 'ArrowLeft') return Math.max(0, at - 1)
  return null
}

type Box = { top: number; left: number; bottom: number; right: number; width: number; height: number }

/** Whether a box can be pointed at: it has a size and some of it is inside the window. */
export function onScreen(box: Box, viewport: { width: number; height: number }): boolean {
  if (box.width <= 0 || box.height <= 0) return false
  return box.bottom > 0 && box.right > 0 && box.top < viewport.height && box.left < viewport.width
}

/** The first of `selectors` whose element is rendered (hidden ones have no box), or null. */
export function findTarget(
  selectors: string[] | undefined,
  root: Pick<Document, 'querySelector'> = document,
): Element | null {
  for (const selector of selectors ?? []) {
    const el = root.querySelector(selector)
    if (el) {
      const box = el.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) return el
    }
  }
  return null
}

/**
 * Whether a dialog is open (New workspace, ⌘K, the shortcut sheet, any modal): the tour then waits behind it and
 * comes back at the same step once it closes. The tour's own card is not modal, so it never counts.
 */
const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"]'
export const dialogOpen = (root: Pick<Document, 'querySelector'> = document) =>
  root.querySelector(MODAL_SELECTOR) !== null

/** The spotlight's window: the target with some room around it, kept inside the screen so its corners show. */
export function spotlightBox(target: Box, viewport: { width: number; height: number }, pad = 6, inset = 4) {
  const left = Math.max(inset, target.left - pad)
  const top = Math.max(inset, target.top - pad)
  const right = Math.min(viewport.width - inset, target.right + pad)
  const bottom = Math.min(viewport.height - inset, target.bottom + pad)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}
