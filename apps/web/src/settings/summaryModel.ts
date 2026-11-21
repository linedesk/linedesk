// The summary cards of Hours & holidays, Rules, Transfers and Notifications without React (LIN-392, LIN-443): what the page's
// settings do, as sentences (a message key and its values) for SummaryCard, and what needs the owner. Each reads
// the same state as its page, so the card changes with every edit.
import { type AiDisclosure, BEHAVIOURS, type BehaviourId, type CommunicationStyle } from '@linedesk/actions'
import type { Closure } from '@linedesk/db/types'
import { msg } from '@linedesk/i18n'
import { i18n } from '../i18n/index.tsx'
import type { SummarySentence } from '../ui/SummaryCard.tsx'
import { type DayHours, timeOptionLabel, weekGroups } from './businessHoursModel.ts'
import type { TransferDraft } from './assistantDraft.ts'
import { addDays, closureState, shortDate, type UpcomingDay } from './closedDaysModel.ts'

export type Summary = { sentences: SummarySentence[]; needsYou: SummarySentence | null }

/** A date that never breaks over two lines: "Thu, Nov 26". */
const dateOf = (date: string, today: string) => shortDate(date, today).replace(/ /g, '\u00a0')

/** How far ahead the hours card names the next closed day. */
export const NEXT_CLOSED_DAYS = 30

// ---------------------------------------------------------------------------------------------------------------
// Hours & holidays

type HoursInput = {
  /** The assistant's name. */
  name: string
  /** The workspace uses business hours. */
  on: boolean
  days: readonly DayHours[]
  /** The closed days from today on (upcomingDays). */
  upcoming: readonly UpcomingDay[]
  closure: Closure | null
  /** Today in the workspace's time zone (YYYY-MM-DD). */
  today: string
  /** The assistant has its own greeting for outside business hours. */
  outsideGreeting: boolean
}

/** The first closed day (or day with shorter hours) within the next NEXT_CLOSED_DAYS days; none: null. */
export function nextClosedDay(upcoming: readonly UpcomingDay[], today: string): UpcomingDay | null {
  const last = addDays(today, NEXT_CLOSED_DAYS)
  return upcoming.find(d => d.kind !== 'opened' && d.date >= today && d.date <= last) ?? null
}

function closedDaySentence(day: UpcomingDay, today: string): SummarySentence {
  const date = dateOf(day.date, today)
  if (day.start && day.end)
    return {
      k: msg('settings.summary.hours.nextShorter'),
      values: {
        date,
        hours: i18n().t('settings.hours.range', { start: timeOptionLabel(day.start), end: timeOptionLabel(day.end) }),
      },
    }
  return day.name
    ? { k: msg('settings.summary.hours.nextClosedNamed'), values: { date, day: day.name } }
    : { k: msg('settings.summary.hours.nextClosed'), values: { date } }
}

function closureSentence(closure: Closure | null, today: string, name: string): SummarySentence | null {
  if (!closure) return null
  const state = closureState(closure, today)
  if (state === 'on')
    return { k: msg('settings.summary.hours.vacationOn'), values: { name, until: dateOf(closure.until, today) } }
  if (state === 'scheduled')
    return {
      k: msg('settings.summary.hours.vacationScheduled'),
      values: { from: dateOf(closure.from, today), until: dateOf(closure.until, today) },
    }
  return null
}

/** "You are open Mon–Fri 8:00 AM–6:00 PM and Sat 9:00 AM–1:00 PM. Next closed day: Thanksgiving Day, Thu, Nov 26." */
export function hoursSummary({ name, on, days, upcoming, closure, today, outsideGreeting }: HoursInput): Summary {
  const groups = weekGroups(days)
  const sentences: SummarySentence[] = []
  const vacation = closureSentence(closure, today, name)
  if (vacation && closureState(closure!, today) === 'on') sentences.push(vacation)
  if (!groups.length) sentences.push({ k: msg('settings.summary.hours.none'), values: { name } })
  else if (!on) sentences.push({ k: msg('settings.summary.hours.off'), values: { name } })
  else {
    sentences.push({ k: msg('settings.summary.hours.open'), values: { hours: groups } })
    if (outsideGreeting) sentences.push({ k: msg('settings.summary.hours.outsideGreeting') })
  }
  // Closed days count only while hours are used (businessHoursFor), so they are named only then (LIN-692).
  const next = on && groups.length ? nextClosedDay(upcoming, today) : null
  if (next) sentences.push(closedDaySentence(next, today))
  if (vacation && !sentences.includes(vacation)) sentences.push(vacation)
  // No business hours is a choice, not a problem: the assistant answers every call the same way (Janik, 2026-11-18).
  return { sentences, needsYou: null }
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

type RulesInput = {
  name: string
  style: CommunicationStyle
  disclosure: AiDisclosure
  /** The checklist as the draft holds it: every switch, on or off. */
  behaviours: Readonly<Record<BehaviourId, boolean>>
}

/** What each switch of the checklist does, as a part of "Maya asks for the caller's name, …". */
const RULE_ITEMS = {
  ask_name: msg('settings.summary.rules.item.askName'),
  offer_callback: msg('settings.summary.rules.item.offerCallback'),
  confirm_number: msg('settings.summary.rules.item.confirmNumber'),
  caller_history: msg('settings.summary.rules.item.callerHistory'),
  ask_booking_name: msg('settings.summary.rules.item.askBookingName'),
  verified_caller_only: msg('settings.summary.rules.item.verifiedCallerOnly'),
} as const satisfies Record<BehaviourId, unknown>

/** "Maya speaks in its standard tone and says it is an AI only when asked. Maya asks for the caller's name, …" */
export function rulesSummary({ name, style, disclosure, behaviours }: RulesInput): Summary {
  const { t } = i18n()
  const items = BEHAVIOURS.filter(b => behaviours[b.id]).map(b => t(RULE_ITEMS[b.id]))
  return {
    sentences: [
      { k: msg('settings.summary.rules.tone'), values: { name, style, disclosure } },
      items.length
        ? { k: msg('settings.summary.rules.does'), values: { name, items } }
        : { k: msg('settings.summary.rules.none') },
    ],
    needsYou: null,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transfers

type TransfersInput = {
  name: string
  transfers: readonly TransferDraft[]
  /** The workspace uses business hours: "only during business hours" applies. */
  hoursOn: boolean
  /** Vacation mode is on today: nobody is put through. */
  vacationOn: boolean
}

const contactName = (c: TransferDraft) => c.name.trim() || i18n().t('settings.transfer.newContact')

/** "Maya puts callers through to Mike Brennan and Office: the first one whose condition fits. …" */
export function transfersSummary({ name, transfers, hoursOn, vacationOn }: TransfersInput): Summary {
  const live = transfers.filter(c => c.enabled && c.number.trim())
  // Switched on without a number: the assistant skips it and takes a message. Said plainly at the end, never as
  // "Needs you" (Janik, 2026-11-18): calls are still answered; the contact itself says what to do.
  const noNumber = transfers.filter(c => c.enabled && !c.number.trim()).map(contactName)
  const skipped: SummarySentence[] = noNumber.length
    ? [{ k: msg('settings.summary.transfers.noNumber'), values: { name, contacts: noNumber, count: noNumber.length } }]
    : []
  if (!live.length)
    return { sentences: [{ k: msg('settings.summary.transfers.none'), values: { name } }, ...skipped], needsYou: null }
  const sentences: SummarySentence[] = [
    { k: msg('settings.summary.transfers.to'), values: { name, contacts: live.map(contactName), count: live.length } },
  ]
  const hoursOnly = hoursOn ? live.filter(c => c.hours_only).map(contactName) : []
  if (hoursOnly.length === live.length) sentences.push({ k: msg('settings.summary.transfers.allHoursOnly') })
  else if (hoursOnly.length)
    sentences.push({
      k: msg('settings.summary.transfers.hoursOnly'),
      values: { contacts: hoursOnly, count: hoursOnly.length },
    })
  sentences.push({ k: msg('settings.summary.transfers.otherwise'), values: { name } })
  if (vacationOn) sentences.push({ k: msg('settings.summary.transfers.vacation') })
  return { sentences: [...sentences, ...skipped], needsYou: null }
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications

type NotificationsInput = {
  email: boolean
  /** An email when a call is assigned to you (only for members who can be assigned calls). */
  assigned: boolean
  setupEmails: boolean
  /** This device: push notifications (also when the app is closed), only while the app is open, or none. */
  device: 'push' | 'open' | null
  /** Other devices of yours that get push notifications in this workspace. */
  otherDevices: number
  /** Push notifications say what the call was about. */
  pushSummary: boolean
  brand: string
}

/** "You get an email for every call and push notifications on this device." */
export function notificationsSummary(input: NotificationsInput): Summary {
  const { t } = i18n()
  const items = [
    input.email && t('account.notify.card.email'),
    input.assigned && t('account.notify.card.assigned'),
    input.setupEmails && t('account.notify.card.setup'),
    input.device === 'push' && t('account.notify.card.devicePush'),
    input.device === 'open' && t('account.notify.card.deviceOpen', { brand: input.brand }),
    input.otherDevices > 0 && t('account.notify.card.otherDevices', { count: input.otherDevices }),
  ].filter((item): item is string => !!item)
  if (!items.length) return { sentences: [{ k: msg('account.notify.card.none') }], needsYou: null }
  const sentences: SummarySentence[] = [{ k: msg('account.notify.card.gets'), values: { items } }]
  if (input.pushSummary && (input.device === 'push' || input.otherDevices > 0))
    sentences.push({ k: msg('account.notify.card.withSummary') })
  return { sentences, needsYou: null }
}
