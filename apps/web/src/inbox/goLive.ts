// The go-live checklist without React: which steps there are, which are done, and whether it shows.
// Owners and admins see it in the inbox after onboarding (the product tour follows once it is done, LIN-85): what is
// left before the assistant really answers the business's calls, and each row ticks itself once that is true.
// Which number, what counts as live and the order of the steps come from @linedesk/actions (setup-state.ts), the
// same definition the setup emails and Admin › Onboarding use.
import {
  type GoLiveChecklistData,
  type GoLiveStep,
  type GoLiveStepScope,
  type GoLiveStepState,
  forwardsCalls,
  goLiveStepScope,
  setupNumber,
  skippableGoLiveSteps,
  takesAllCalls,
  type TeamData,
} from '@linedesk/actions'
import type { AssistantCalendar, CalendarConnection, Call, PhoneNumber } from '@linedesk/db/types'
import { brandName } from '../brand.ts'

export type GoLiveId = GoLiveStep

export type GoLiveItem = {
  id: GoLiveId
  label: string
  /** One line under the label: what to do, or what happens. */
  hint: string
  done: boolean
  /** Where it is done; null when there is nothing to open (the first real call comes by itself). */
  href: string | null
  /** `person`: about the viewer's own devices, so done and "Not needed" are theirs alone (goLiveStepScope). */
  scope: GoLiveStepScope
}

export type GoLiveFacts = {
  /**
   * The server can answer calls (speech, language model and voice, or a realtime model). null: the row is left out
   * (set up all along on this install). `canFix`: the viewer is an instance admin, who sets it up under Admin › Providers.
   */
  voice: { ready: boolean; failing: boolean; canFix: boolean } | null
  hasNumber: boolean
  /**
   * The number whose forwarding codes the row opens; null with numbers that need no forwarding (bought or
   * ported numbers that callers dial directly): then the row is left out. Without any number: 'none'.
   */
  forwardingNumberId: string | 'none' | null
  /** The forwarding number takes every call (forward all), not only the missed ones (takesAllCalls). Says how the forwarding row reads. */
  forwardingTakesAllCalls: boolean
  forwardingVerified: boolean
  /** Live (isLive): a real caller reached the assistant. */
  firstRealCall: boolean
  /** null: no calendar provider on this install (and none connected), so the row is left out. */
  calendarConnected: boolean | null
  /** The viewer's own devices; null: push is not set up on this install, so the row is left out. */
  pushOn: boolean | null
  teamInvited: boolean
}

/** The one sentence for a server whose voice service is not set up: the inbox header and the go-live checklist. */
export const voiceNotSetUp = (assistant: string) =>
  `${assistant} can't answer calls yet: the voice service isn't set up.`
/** What to do about it: instance admins set it up themselves, everyone else asks whoever runs the server. */
export const voiceFix = (canFix: boolean) =>
  canFix ? 'Set it up under Admin › Providers.' : 'Ask whoever runs this server.'
/** Set up, but a provider it needs is failing (a used-up quota, a rejected key): the header and the checklist. */
export const voiceFailing = (assistant: string, canFix: boolean) =>
  `${assistant} can't answer calls: a service it needs is failing (a used-up quota or a rejected key). ${
    canFix ? 'Fix it under Admin › Providers.' : 'Ask whoever runs this server.'
  }`

export function goLiveItems(facts: GoLiveFacts, assistant: string): GoLiveItem[] {
  const items: Omit<GoLiveItem, 'scope'>[] = [
    {
      id: 'number',
      label: 'Connect your number',
      hint: `So ${assistant} can answer your calls`,
      done: facts.hasNumber,
      href: '#settings/phone',
    },
    {
      id: 'forwarding',
      label: 'Turn on call forwarding',
      hint: facts.forwardingTakesAllCalls ? `Every call goes to ${assistant}` : `Calls you miss go to ${assistant}`,
      done: facts.forwardingVerified,
      href:
        facts.forwardingNumberId && facts.forwardingNumberId !== 'none'
          ? `#settings/phone/${facts.forwardingNumberId}`
          : '#settings/phone',
    },
    {
      id: 'first_call',
      label: 'Get your first real call',
      hint: "Call your business from a phone that isn't yours or your team's",
      done: facts.firstRealCall,
      href: null,
    },
  ]
  if (facts.forwardingNumberId === null) items.splice(1, 1)
  // First when it applies: nothing else matters while nothing can answer.
  if (facts.voice)
    items.unshift({
      id: 'voice',
      label: `${assistant} can answer calls`,
      hint: facts.voice.ready
        ? voiceFailing(assistant, facts.voice.canFix)
        : `${voiceNotSetUp(assistant)} ${voiceFix(facts.voice.canFix)}`,
      done: facts.voice.ready && !facts.voice.failing,
      href: facts.voice.canFix ? '#admin/providers' : null,
    })
  if (facts.calendarConnected !== null)
    items.push({
      id: 'calendar',
      label: 'Connect your calendar',
      hint: `So ${assistant} can book appointments`,
      done: facts.calendarConnected,
      href: '#assistant/booking',
    })
  if (facts.pushOn !== null)
    items.push({
      id: 'push',
      label: 'Get calls on your phone',
      hint: `Add ${brandName()} to your Home Screen, then allow notifications`,
      done: facts.pushOn,
      href: '#settings/notifications',
    })
  items.push({
    id: 'team',
    label: 'Invite your team',
    hint: 'They get the calls meant for them',
    done: facts.teamInvited,
    href: '#team',
  })
  return items.map(item => ({ ...item, scope: goLiveStepScope[item.id] }))
}

/** Whether "Not needed" is offered: every step but the voice service, the number and the first real call (an old skipped row for them is ignored). */
export const canSkipGoLiveStep = (id: GoLiveId) => (skippableGoLiveSteps as readonly string[]).includes(id)

/**
 * The steps sorted for the card at `now`. `open`: still to do (in setup order, with the done ones in `rows` beside
 * them). `later`: put off and not back yet, earliest first. `skipped`: marked not needed. A done step is done,
 * whatever else was said about it; a later step whose date has passed is open again.
 */
export type GoLiveView = {
  rows: GoLiveItem[]
  open: GoLiveItem[]
  later: { item: GoLiveItem; until: Date }[]
  skipped: GoLiveItem[]
}

export function goLiveView(
  items: readonly GoLiveItem[],
  steps: readonly GoLiveStepState[] | undefined,
  now: Date,
): GoLiveView {
  const skipped = new Set(steps?.filter(s => s.state === 'skipped' && canSkipGoLiveStep(s.step)).map(s => s.step))
  const later = new Map<GoLiveId, Date>()
  for (const s of steps ?? []) {
    if (s.state !== 'later' || !s.until) continue
    const until = new Date(s.until)
    if (until > now) later.set(s.step, until)
  }
  const view: GoLiveView = { rows: [], open: [], later: [], skipped: [] }
  for (const item of items) {
    if (item.done) view.rows.push(item)
    else if (skipped.has(item.id)) view.skipped.push(item)
    else if (later.has(item.id)) view.later.push({ item, until: later.get(item.id)! })
    else {
      view.rows.push(item)
      view.open.push(item)
    }
  }
  view.later.sort((a, b) => a.until.getTime() - b.until.getTime())
  return view
}

/**
 * Shown to owners and admins of a workspace past onboarding while a step is open, unless they closed it.
 * Every step done or not needed: finished. Only later steps left: hidden until the first of them comes back.
 * `pinned`: opened again from ⌘K, so it shows even then.
 */
export function goLiveShown(
  server: GoLiveChecklistData | undefined,
  items: readonly GoLiveItem[],
  pinned = false,
  now = new Date(),
): boolean {
  if (!server?.shown || server.dismissed) return false
  return pinned || goLiveView(items, server.steps, now).open.length > 0
}

/** Nothing more to learn from the server: not shown here, closed, or both of its facts true. Then it is not read again on its own. */
export const goLiveSettled = (server: GoLiveChecklistData | undefined) =>
  Boolean(server && (!server.shown || server.dismissed || (server.forwardingVerified && server.firstRealCall)))

/** The number the forwarding row is about: the setup number (setupNumber) when it forwards; 'none' without numbers, null when none forwards. */
export function forwardingNumber<N extends Pick<PhoneNumber, 'id' | 'mode' | 'created_at'>>(
  numbers: readonly N[],
): N | 'none' | null {
  const number = setupNumber(numbers)
  if (!number) return 'none'
  return forwardsCalls(number.mode) ? number : null
}

/** The forwarding row's facts from the numbers: which number it opens and whether that one takes every call. */
export function forwardingFacts(
  numbers: readonly Pick<PhoneNumber, 'id' | 'mode' | 'created_at'>[],
): Pick<GoLiveFacts, 'forwardingNumberId' | 'forwardingTakesAllCalls'> {
  const number = forwardingNumber(numbers)
  if (number === 'none' || number === null) return { forwardingNumberId: number, forwardingTakesAllCalls: false }
  return { forwardingNumberId: number.id, forwardingTakesAllCalls: takesAllCalls(number.mode) }
}

/** A real caller reached a number in a forwarding mode: forwarding works, whether or not it was checked. */
export function forwardedCallArrived(
  calls: readonly Pick<Call, 'source' | 'from_own_number' | 'outcome' | 'to_number'>[],
  numbers: readonly Pick<PhoneNumber, 'e164' | 'mode'>[],
): boolean {
  const forwarded = new Set(numbers.filter(n => forwardsCalls(n.mode)).map(n => n.e164))
  return calls.some(c => c.source === 'phone' && !c.from_own_number && forwarded.has(c.to_number))
}

/** A calendar the assistant can book into: a connection that works, with one of its calendars attached. */
export function calendarReady(
  connections: readonly Pick<CalendarConnection, 'id' | 'status'>[],
  attached: readonly Pick<AssistantCalendar, 'connection_id'>[],
): boolean {
  const used = new Set(attached.map(a => a.connection_id))
  return connections.some(c => c.status === 'connected' && used.has(c.id))
}

/** Someone else is in the workspace, or invited and the invitation still works. */
export const teamInvited = (team: Pick<TeamData, 'members' | 'invitations'>) =>
  team.members.length > 1 || team.invitations.some(i => !i.expired)

/** "2 of 6", "5 of 6 (1 not needed)": a step marked not needed counts as handled. */
export function goLiveProgress(view: GoLiveView): string {
  const total = view.rows.length + view.later.length + view.skipped.length
  const handled = view.rows.length - view.open.length + view.skipped.length
  return `${handled} of ${total}${view.skipped.length ? ` (${view.skipped.length} not needed)` : ''}`
}

/** "Nov 16". */
export const goLiveDate = (at: Date) => at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** The hint row in the inbox until the first real call: what happens when one comes in. */
export const firstCallHint = (assistant: string) =>
  `When someone calls, ${assistant} answers and the call shows up here with a summary and what to do next.`
