// The go-live checklist without React: which steps there are, which are done, and whether it shows.
// Owners and admins see it in the inbox after onboarding (the product tour follows once it is done, LIN-85): what is
// left before the assistant really answers the business's calls, and each row ticks itself once that is true.
// Which number, what counts as live and the order of the steps come from @linedesk/actions (setup-state.ts), the
// same definition the setup emails and Server admin › Workspaces › At risk use.
import {
  type BusinessKind,
  forwardsCalls,
  type GoLiveChecklistData,
  type GoLiveStep,
  type GoLiveStepScope,
  type GoLiveStepState,
  goLiveStepFor,
  goLiveStepScope,
  setupNumber,
  skippableGoLiveSteps,
  type TeamData,
  takesAllCalls,
} from '@linedesk/actions'
import type { AssistantCalendar, CalendarConnection, PhoneNumber } from '@linedesk/db/types'
import { brandName } from '../brand.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { type ForwardedCall, realCallReached } from '../onboarding/forwarding-check.ts'
import type { Presence } from '../shell/presence.ts'

export type GoLiveId = GoLiveStep

/** Integrations › Outlook when the connected mailbox is an Outlook one, else › Gmail (the analysis shows on both). */
const mailPage = (facts: { mailboxProvider?: 'google' | 'microsoft' | null }) =>
  facts.mailboxProvider === 'microsoft' ? '#integrations/outlook-mail' : '#integrations/gmail'

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
   * (set up all along on this install). `canFix`: the viewer is an instance admin, who sets it up under Server admin ›
   * Providers.
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
  /** The kind of business: which of the steps below are for it (goLiveStepFor); null: never picked. */
  businessKind: BusinessKind | null
  /** A Shopify store / a Jobber account is connected (app_connections; one that needs attention counts too). */
  shopifyConnected: boolean
  jobberConnected: boolean
  /** A support mailbox (Gmail or Outlook) is connected (mail_connections). */
  mailboxConnected: boolean
  /** The provider of the first connected mailbox: its page holds the support mail analysis (Outlook-only too). */
  mailboxProvider?: 'google' | 'microsoft' | null
  /** The FAQ from the support mail is reviewed (GoLiveChecklistData.faqReviewed). */
  faqReviewed: boolean
}

/** The one sentence for a server whose voice service is not set up: the inbox header and the go-live checklist. */
export const voiceNotSetUp = (assistant: string) => i18n().t('inbox.voice.notSetUp', { assistant })
/**
 * What to do about it: instance admins set it up themselves. Nobody else in a workspace can, owners included, so they
 * are not sent to ask anyone ("whoever runs this server" means nothing on Cloud): the row ticks itself once it works.
 */
export const voiceFix = (canFix: boolean) =>
  canFix ? i18n().t('inbox.voice.setUpInAdmin') : i18n().t('inbox.voice.nothingToDo')
/** Set up, but a provider it needs is failing (a used-up quota, a rejected key): the header and the checklist. */
export const voiceFailing = (assistant: string, canFix: boolean) =>
  i18n().t('inbox.voice.failing', {
    assistant,
    fix: canFix ? i18n().t('inbox.voice.fixInAdmin') : i18n().t('inbox.voice.nothingToDoFailing'),
  })

/** Where an instance admin sets up or fixes the voice service. */
export const VOICE_FIX_HASH = '#admin/providers/answering'

/**
 * Why the assistant is not answering calls, and the fix: one answer for the inbox header ("Maya can't answer calls
 * yet · Set up") and Settings › Phone numbers (the note under a number that is not answering). `title`: the
 * consequence; `why`: the reason, with what the viewer can do about it when there is no link; `fix`: the place that
 * fixes it, only for who can open it (the voice service: instance admins). null while the assistant answers, while it
 * is not known yet, and offline: then nothing is known about it, and the app-wide offline bar already says so (never a
 * false "can't answer calls", LIN-771).
 */
export type NotAnsweringWhy = {
  reason: 'number' | 'voice' | 'failing'
  title: string
  why: string
  fix: { href: string; label: string } | null
}

export function notAnsweringWhy(presence: Presence, assistant: string, canFix: boolean): NotAnsweringWhy | null {
  const { t } = i18n()
  if (presence.kind !== 'notAnswering') return null
  if (presence.reason === 'number')
    return {
      reason: 'number',
      title: t('inbox.presence.cannotAnswerYet', { assistant }),
      why: t('inbox.presence.noNumberTitle', { assistant }),
      fix: { href: CONNECT_NUMBER, label: t('inbox.presence.setUp') },
    }
  const failing = presence.reason === 'failing'
  const fix = canFix
    ? { href: VOICE_FIX_HASH, label: failing ? t('inbox.presence.fix') : t('inbox.presence.setUp') }
    : null
  return failing
    ? {
        reason: 'failing',
        title: t('inbox.presence.cannotAnswer', { assistant }),
        why: fix
          ? t('inbox.voice.failingWhy')
          : `${t('inbox.voice.failingWhy')} ${t('inbox.voice.nothingToDoFailing')}`,
        fix,
      }
    : {
        reason: 'voice',
        title: t('inbox.presence.cannotAnswerYet', { assistant }),
        why: fix ? t('inbox.voice.notSetUpWhy') : `${t('inbox.voice.notSetUpWhy')} ${voiceFix(false)}`,
        fix,
      }
}

/**
 * The inbox header's "can't answer calls yet" line is left out while the checklist's steps are on screen: its open
 * steps (Maya can answer calls, Connect your number) say the same, with the way to fix it. A live call, "answering"
 * and "offline" are not checklist steps and always show.
 */
export const presenceSaidByChecklist = (presence: Presence, checklistSteps: boolean) =>
  checklistSteps && presence.kind === 'notAnswering'

/** Where a number is connected: the go-live step and the empty inbox open it. */
export const CONNECT_NUMBER = '#workspace/phone'

export function goLiveItems(facts: GoLiveFacts, assistant: string): GoLiveItem[] {
  const { t } = i18n()
  const items: Omit<GoLiveItem, 'scope'>[] = [
    {
      id: 'number',
      label: t('inbox.goLive.number.label'),
      hint: t('inbox.goLive.number.hint', { assistant }),
      done: facts.hasNumber,
      href: CONNECT_NUMBER,
    },
    {
      id: 'forwarding',
      label: t('inbox.goLive.forwarding.label'),
      hint: facts.forwardingTakesAllCalls
        ? t('inbox.goLive.forwarding.hintAll', { assistant })
        : t('inbox.goLive.forwarding.hintMissed', { assistant }),
      done: facts.forwardingVerified,
      href:
        facts.forwardingNumberId && facts.forwardingNumberId !== 'none'
          ? `#workspace/phone/${facts.forwardingNumberId}`
          : '#workspace/phone',
    },
    {
      id: 'first_call',
      label: t('inbox.goLive.firstCall.label'),
      hint: t('inbox.goLive.firstCall.hint'),
      done: facts.firstRealCall,
      href: null,
    },
  ]
  if (facts.forwardingNumberId === null) items.splice(1, 1)
  // First when it applies: nothing else matters while nothing can answer.
  if (facts.voice)
    items.unshift({
      id: 'voice',
      label: t('inbox.goLive.voice.label', { assistant }),
      hint: facts.voice.ready
        ? voiceFailing(assistant, facts.voice.canFix)
        : `${voiceNotSetUp(assistant)} ${voiceFix(facts.voice.canFix)}`,
      done: facts.voice.ready && !facts.voice.failing,
      href: facts.voice.canFix ? VOICE_FIX_HASH : null,
    })
  if (facts.calendarConnected !== null)
    items.push({
      id: 'calendar',
      label: t('inbox.goLive.calendar.label'),
      hint: t('inbox.goLive.calendar.hint', { assistant }),
      done: facts.calendarConnected,
      href: '#assistant/booking',
    })
  items.push(
    {
      id: 'shopify',
      label: t('inbox.goLive.shopify.label'),
      hint: t('inbox.goLive.shopify.hint', { assistant }),
      done: facts.shopifyConnected,
      href: '#integrations/shopify',
    },
    {
      id: 'jobber',
      label: t('inbox.goLive.jobber.label'),
      hint: t('inbox.goLive.jobber.hint'),
      done: facts.jobberConnected,
      href: '#integrations/jobber',
    },
    {
      id: 'support_email',
      label: t('inbox.goLive.supportEmail.label'),
      hint: t('inbox.goLive.supportEmail.hint'),
      done: facts.mailboxConnected,
      href: mailPage(facts),
    },
    {
      id: 'faq',
      label: t('inbox.goLive.faq.label'),
      hint: t('inbox.goLive.faq.hint', { assistant }),
      done: facts.faqReviewed,
      href: mailPage(facts),
    },
  )
  if (facts.pushOn !== null)
    items.push({
      id: 'push',
      label: t('inbox.goLive.push.label'),
      hint: t('inbox.goLive.push.hint', { brand: brandName() }),
      done: facts.pushOn,
      href: '#account/preferences',
    })
  items.push({
    id: 'team',
    label: t('inbox.goLive.team.label'),
    hint: t('inbox.goLive.team.hint'),
    done: facts.teamInvited,
    href: '#workspace/team',
  })
  // Only the steps for this kind of business (LIN-680): an online store gets Shopify and no calendar, say.
  return items
    .filter(item => goLiveStepFor(item.id, facts.businessKind))
    .map(item => ({ ...item, scope: goLiveStepScope[item.id] }))
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

/** Nothing more to learn from the server: not shown here, closed, or its facts true (the FAQ one only where the step shows). Then it is not read again on its own. */
export const goLiveSettled = (server: GoLiveChecklistData | undefined) =>
  Boolean(
    server &&
      (!server.shown ||
        server.dismissed ||
        (server.forwardingVerified &&
          server.firstRealCall &&
          (server.faqReviewed !== false || !goLiveStepFor('faq', server.businessKind)))),
  )

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

/**
 * A real caller reached the number the forwarding row is about (forwardingNumber, the setup number while it forwards)
 * since it was set up: forwarding works, whether or not it was checked. The server's rule (realCallReached), seen in
 * the browser as the call arrives.
 */
export function forwardedCallArrived(
  calls: readonly ForwardedCall[],
  numbers: readonly Pick<PhoneNumber, 'id' | 'e164' | 'mode' | 'created_at'>[],
): boolean {
  const number = forwardingNumber(numbers)
  return number !== 'none' && number !== null && realCallReached(number, calls)
}

/** A calendar the assistant can book into: a connection that works, with one of its calendars attached. */
export function calendarReady(
  connections: readonly Pick<CalendarConnection, 'id' | 'status'>[],
  attached: readonly Pick<AssistantCalendar, 'connection_id'>[],
): boolean {
  const used = new Set(attached.map(a => a.connection_id))
  return connections.some(c => c.status === 'connected' && used.has(c.id))
}

/** The step the collapsed card names: the first open one the viewer can act on (it has a place to go), else the first. */
export const nextGoLiveStep = (view: Pick<GoLiveView, 'open'>): GoLiveItem | undefined =>
  view.open.find(item => item.href) ?? view.open[0]

/** Someone else is in the workspace, or invited and the invitation still works. */
export const teamInvited = (team: Pick<TeamData, 'members' | 'invitations'>) =>
  team.members.length > 1 || team.invitations.some(i => !i.expired)

/** "2 of 6", "5 of 6 (1 not needed)": a step marked not needed counts as handled. */
export function goLiveProgress(view: GoLiveView): string {
  const total = view.rows.length + view.later.length + view.skipped.length
  const handled = view.rows.length - view.open.length + view.skipped.length
  return view.skipped.length
    ? i18n().t('inbox.goLive.progressSkipped', { handled, total, skipped: view.skipped.length })
    : i18n().t('inbox.goLive.progress', { handled, total })
}

/** "Nov 16". */
export const goLiveDate = (at: Date) => fmt().dateTime(at, { month: 'short', day: 'numeric' })

/** The hint row in the inbox until the first real call: what happens when one comes in. */
export const firstCallHint = (assistant: string) => i18n().t('inbox.firstCallHint', { assistant })
