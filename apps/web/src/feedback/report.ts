// Help › Report a bug / Request a feature (LIN-639): which report is open, the picture of the page taken when it
// opened, the context that may go with it, and sending it (the registry action `feedback.send`, run directly: the
// member waits for the answer, it writes no synced rows).
import {
  FEEDBACK_ERRORS_MAX,
  FEEDBACK_PAGE_MAX,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_TEXT_MAX,
  type FeedbackKind,
  type FeedbackSendData,
  STAR_REPO_URL,
} from '@linedesk/actions'
import { scrubPath } from '@linedesk/scrub'
import { useSyncExternalStore } from 'react'
import { errorsText, recentErrors } from './errorLog.ts'

export type ReportKind = 'bug' | 'feature'

/** The keys that open a report from anywhere in the app (shell/keys.ts). */
export const REPORT_KEYS: Record<ReportKind, string[]> = { bug: ['⇧', 'R'], feature: ['⇧', 'F'] }

/** Where Help › Documentation goes: the README on GitHub (linedesk.ai/docs does not exist; as for the MCP listings). */
export const DOCS_URL = `${STAR_REPO_URL}#readme`

/** The parts that may go with the text; each has a checkbox, all on at first. */
export type ReportPart = 'screenshot' | 'page' | 'errors' | 'system'
export const REPORT_PARTS: ReportPart[] = ['screenshot', 'page', 'errors', 'system']

/** The screenshot while it is taken (`null` when it failed). */
export type Shot = { state: 'taking' } | { state: 'ready'; url: string } | { state: 'failed' }

export type OpenReport = { kind: ReportKind; key: number; shot: Shot; page: string; errors: string; system: string }

/** The input of `feedback.send` (packages/actions/src/feedback.ts). */
export type FeedbackInput = {
  kind: FeedbackKind
  text: string
  page?: string
  context?: { version?: string; browser?: string; errors?: string }
  screenshot?: string
  contact_email?: string
}

export const MAX_TEXT = FEEDBACK_TEXT_MAX
const MAX_PAGE = FEEDBACK_PAGE_MAX
const MAX_ERRORS_TEXT = FEEDBACK_ERRORS_MAX
/** The server takes up to 3 MB of picture; we stay under it. */
const MAX_SHOT_BYTES = Math.floor(FEEDBACK_SCREENSHOT_MAX_BYTES * 0.8)
/** The longest side of the picture, in pixels. */
const MAX_SHOT_SIDE = 2400

/** This build's version (vite.config.ts: APP_BUILD, else the build time). */
export const appVersion = (): string => import.meta.env.VITE_APP_BUILD ?? 'dev'

/** Browser and window, one line: what a bug report needs to reproduce the layout. */
export const browserLine = (): string =>
  `${navigator.userAgent} · ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`.slice(0, 300)

/** The place in the app: the address's route (a hash), without anything secret-looking. */
export const pagePath = (): string => {
  const hash = window.location.hash.replace(/^#/, '')
  return `${window.location.pathname}${hash ? `#${scrubPath(hash)}` : ''}`.slice(0, MAX_PAGE)
}

// ---- which report is open ----

let open: OpenReport | null = null
let shotTaken: Promise<void> = Promise.resolve()
let nextKey = 1
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

/**
 * Opens the report. The picture of the page is started first, from the page as it is now; the menus and the report
 * itself are left out of it (`skipInShot`), so it shows what the member saw.
 */
export function openReport(kind: ReportKind): void {
  if (open) {
    if (open.kind !== kind) {
      open = { ...open, kind }
      emit()
    }
    return
  }
  const key = nextKey++
  open = {
    kind,
    key,
    shot: { state: 'taking' },
    page: pagePath(),
    errors: errorsText(recentErrors()).slice(-MAX_ERRORS_TEXT),
    system: `${appVersion()}\n${browserLine()}`,
  }
  emit()
  shotTaken = takeScreenshot().then(url => {
    if (open?.key !== key) return
    open = { ...open, shot: url ? { state: 'ready', url } : { state: 'failed' } }
    emit()
  })
}

/** The open report once its screenshot is taken (or failed): Send waits for it while the picture is ticked. */
export async function settledReport(): Promise<OpenReport | null> {
  await shotTaken
  return open
}

export function closeReport(): void {
  open = null
  emit()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useOpenReport = () => useSyncExternalStore(subscribe, () => open)

// ---- the picture ----

/** Left out of the picture: floating layers (menus, ⌘K, dialogs, toasts) and the slid-in navigation. */
export function skipInShot(node: Node): boolean {
  if (!(node instanceof Element)) return false
  if (node.closest('[data-no-shot]')) return true
  if (node.matches('.overlay, .k-float, .toast, .scrim, [popover]')) return true
  return node.matches('.nav') && !node.closest('.app.nav-docked')
}

async function takeScreenshot(): Promise<string | null> {
  try {
    const { domToJpeg } = await import('modern-screenshot') // only loaded when someone reports
    const root = document.getElementById('root') ?? document.body
    const width = window.innerWidth
    const height = window.innerHeight
    const scale = Math.min(window.devicePixelRatio || 1, 2, MAX_SHOT_SIDE / Math.max(width, height))
    const options = {
      width,
      height,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      filter: (node: Node) => !skipInShot(node),
      timeout: 8000,
    }
    let url = await domToJpeg(root, { ...options, scale, quality: 0.8 })
    if (dataUrlBytes(url) > MAX_SHOT_BYTES) url = await domToJpeg(root, { ...options, scale: 1, quality: 0.6 })
    return dataUrlBytes(url) > MAX_SHOT_BYTES ? null : url
  } catch {
    return null
  }
}

/** How many bytes a base64 data URL holds. */
export const dataUrlBytes = (url: string): number => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4)

// ---- sending ----

export type Included = Record<ReportPart, boolean>

/** What goes to the server: the text and the parts left ticked. */
export function reportInput(report: OpenReport, text: string, include: Included): FeedbackInput {
  const context: FeedbackInput['context'] = {}
  if (include.system) {
    context.version = appVersion().slice(0, 100)
    context.browser = browserLine()
  }
  if (include.errors && report.errors) context.errors = report.errors
  return {
    kind: report.kind,
    text: text.trim().slice(0, MAX_TEXT),
    ...(include.page ? { page: report.page } : {}),
    ...(Object.keys(context).length ? { context } : {}),
    ...(include.screenshot && report.shot.state === 'ready' ? { screenshot: report.shot.url } : {}),
  }
}

/** Sends the report; throws with the server's reason (a refusal, the hourly limit). */
export async function sendFeedback(input: FeedbackInput): Promise<FeedbackSendData> {
  const { callAction } = await import('../settings/settings-api.ts') // keeps this module light for the key handler
  return callAction<FeedbackSendData>('feedback.send', input)
}
