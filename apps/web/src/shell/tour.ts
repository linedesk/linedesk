// The first-use tour without React: its steps and whether it is due. It starts once after onboarding
// (when the install offers it, FIRST_USE) and again from ⌘K "Show the tour". Kept in this browser only:
// a convenience, not a record.

export type TourStep = {
  title: string
  text: string
  /** CSS selector of what the step explains, outlined while it shows; none when it is not on screen. */
  target?: string
}

export function tourSteps(assistant: string): TourStep[] {
  return [
    {
      title: 'Your inbox',
      text: `Every call ${assistant} answers lands here with a summary and the next step. J and K move.`,
      target: '.ib-list',
    },
    {
      title: 'Open a call',
      text: 'Enter opens the call under the cursor: what it is about, the transcript, the recording. Esc goes back.',
      target: '.ib-list .row',
    },
    {
      title: 'Assign and finish',
      text: 'A assigns a call to you, H reminds you later, E marks it done and moves on. Z undoes.',
      target: '.ib-list .row',
    },
    {
      title: 'Settings',
      text: `G then S opens Settings: phone numbers, hours, notifications. G then A sets up ${assistant}.`,
      target: '.menu-btn',
    },
    {
      title: 'Everything else',
      text: '⌘K finds any action, ? lists every shortcut. That is the tour.',
    },
  ]
}

const PENDING_KEY = 'linedesk.tour.pending'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private window: the tour then just does not come back on its own */
  }
}

/** Onboarding just finished in this browser for `workspaceId`: the tour starts in its inbox. */
export const queueTour = (workspaceId: string) => write(PENDING_KEY, workspaceId)
export const tourDue = (workspaceId: string) => read(PENDING_KEY) === workspaceId
/** Done or dismissed: it does not start again on its own. */
export const finishTour = () => write(PENDING_KEY, null)

/** The next step for a key, or 'close'; null for keys the tour leaves to the app. */
export function tourKey(key: string, at: number, count: number): number | 'close' | null {
  if (key === 'Escape') return 'close'
  if (key === 'ArrowRight') return at + 1 >= count ? 'close' : at + 1
  if (key === 'ArrowLeft') return Math.max(0, at - 1)
  return null
}
