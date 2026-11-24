import { expect, test } from 'vitest'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import type { SummarySentence } from '../ui/SummaryCard.tsx'
import type { TransferDraft } from './assistantDraft.ts'
import { dayRows } from './businessHoursModel.ts'
import type { UpcomingDay } from './closedDaysModel.ts'
import {
  hoursSummary,
  nextClosedDay,
  notificationsSummary,
  rulesSummary,
  type Summary,
  transfersSummary,
} from './summaryModel.ts'

/** A sentence as plain text: lists joined as the card joins them, tags (bold, a link) as their words. */
function text(sentence: SummarySentence | null): string {
  if (!sentence) return ''
  const words = (chunks: string[]) => chunks.join('')
  const values: Record<string, unknown> = { b: words, link: words }
  for (const [name, value] of Object.entries(sentence.values ?? {}))
    values[name] = Array.isArray(value) ? fmt().list(value as string[]) : value
  // Dates do not break over two lines (no-break spaces); compared with plain ones here.
  return i18n()
    .t(sentence.k, values as never)
    .replace(/\u00a0/g, ' ')
}
const all = (s: Summary) => s.sentences.map(text).join(' ')

const today = '2026-11-16'
const week = dayRows([
  ...[1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '08:00', end: '18:00' })),
  { weekday: 6, start: '09:00', end: '13:00' },
])
const day = (date: string, name: string, more: Partial<UpcomingDay> = {}): UpcomingDay => ({
  date,
  name,
  start: null,
  end: null,
  kind: 'holiday',
  key: name,
  yearly: false,
  changed: false,
  ...more,
})
const hours = { name: 'Maya', on: true, days: week, upcoming: [], closure: null, today, outsideGreeting: false }

test('hours: the open days grouped, the next closed day, vacation mode', () => {
  expect(all(hoursSummary(hours))).toBe('You are open Mon–Fri 8:00 AM–6:00 PM and Sat 9:00 AM–1:00 PM.')
  const thanksgiving = day('2026-11-26', 'Thanksgiving Day')
  expect(all(hoursSummary({ ...hours, upcoming: [thanksgiving], outsideGreeting: true }))).toBe(
    'You are open Mon–Fri 8:00 AM–6:00 PM and Sat 9:00 AM–1:00 PM. Outside these hours, callers hear the after-hours greeting. Next closed day: Thanksgiving Day, Thu, Nov 26.',
  )
  const closure = { from: '2026-11-14', until: '2026-11-20', greeting: '' }
  expect(hoursSummary({ ...hours, closure }).sentences.map(s => s.k)).toEqual([
    'settings.summary.hours.vacationOn',
    'settings.summary.hours.open',
  ])
  expect(text(hoursSummary({ ...hours, closure }).sentences[0]!)).toBe(
    'Vacation mode is on until Fri, Nov 20: Maya takes a message on every call.',
  )
  const later = { from: '2026-12-21', until: '2026-12-31', greeting: '' }
  expect(text(hoursSummary({ ...hours, closure: later }).sentences.at(-1)!)).toBe(
    'Vacation mode is set for Mon, Dec 21 to Thu, Dec 31.',
  )
  // An ended closure says nothing.
  expect(hoursSummary({ ...hours, closure: { ...closure, until: '2026-11-15' } }).sentences).toHaveLength(1)
})

test('hours: only closed days within 30 days, never a day opened this year', () => {
  expect(nextClosedDay([day('2026-12-25', 'Christmas Day')], today)).toBeNull()
  expect(nextClosedDay([day('2026-11-26', 'Thanksgiving Day', { kind: 'opened' })], today)).toBeNull()
  const short = day('2026-11-27', '', { kind: 'own', start: '08:00', end: '12:00' })
  expect(text(hoursSummary({ ...hours, upcoming: [short] }).sentences[1]!)).toBe(
    'Shorter hours on Fri, Nov 27: open 8:00 AM–Noon.',
  )
  expect(text(hoursSummary({ ...hours, upcoming: [day('2026-11-27', '', { kind: 'own' })] }).sentences[1]!)).toBe(
    'Next closed day: Fri, Nov 27.',
  )
})

test('hours: none set is fine, never "Needs you"; off says so', () => {
  const none = hoursSummary({ ...hours, days: dayRows([]) })
  expect(all(none)).toBe('No business hours: Maya answers every call the same way, at any time.')
  expect(none.needsYou).toBeNull()
  const off = hoursSummary({ ...hours, on: false })
  expect(all(off)).toBe('Business hours are off: Maya answers every call the same way, at any time.')
  expect(off.needsYou).toBeNull()
  // Closed days count only while hours are used: off names none, even with one coming up (LIN-692).
  expect(all(hoursSummary({ ...hours, on: false, upcoming: [day('2026-11-26', 'Thanksgiving Day')] }))).not.toMatch(
    /closed day/i,
  )
})

const contact = (name: string, more: Partial<TransferDraft> = {}): TransferDraft => ({
  id: name,
  name,
  number: '+15035550142',
  condition: 'The caller asks for a person',
  hours_only: false,
  ring_seconds: 20,
  if_no_answer: 'next',
  enabled: true,
  briefing: true,
  ...more,
})
const transfers = { name: 'Maya', transfers: [], hoursOn: true, vacationOn: false }

test('transfers: who, in order, and what happens otherwise', () => {
  const two = [contact('Mike Brennan'), contact('Office', { hours_only: true })]
  expect(all(transfersSummary({ ...transfers, transfers: two }))).toBe(
    'Maya puts callers through to Mike Brennan and Office, the first one whose condition fits. Office takes calls only during business hours. When none fits or nobody answers, Maya takes a message.',
  )
  // Without business hours, "only during business hours" does not apply.
  expect(all(transfersSummary({ ...transfers, transfers: two, hoursOn: false }))).not.toContain('business hours')
  expect(all(transfersSummary({ ...transfers, transfers: [contact('Office', { hours_only: true })] }))).toBe(
    'Maya puts callers through to Office when the condition fits. Outside business hours, nobody is put through. When none fits or nobody answers, Maya takes a message.',
  )
  expect(all(transfersSummary({ ...transfers, transfers: two, vacationOn: true }))).toContain(
    'Vacation mode is on: nobody is put through until it ends.',
  )
})

test('transfers: none, switched off, or without a number', () => {
  expect(all(transfersSummary(transfers))).toBe('Maya puts no calls through; it takes a message.')
  const off = transfersSummary({ ...transfers, transfers: [contact('Mike Brennan', { enabled: false })] })
  expect(all(off)).toBe('Maya puts no calls through; it takes a message.')
  expect(off.needsYou).toBeNull()
  const missing = transfersSummary({
    ...transfers,
    transfers: [contact('Mike Brennan'), contact('Office', { number: ' ' })],
  })
  // Not a "Needs you": calls are still answered, and the contact itself says what to do.
  expect(missing.needsYou).toBeNull()
  expect(all(missing)).toContain('Maya puts callers through to Mike Brennan when the condition fits.')
  expect(all(missing)).toMatch(/Office has no number, so Maya skips it\.$/)
  const onlyMissing = transfersSummary({ ...transfers, transfers: [contact('Office', { number: '' })] })
  expect(onlyMissing.needsYou).toBeNull()
  expect(all(onlyMissing)).toBe(
    'Maya puts no calls through; it takes a message. Office has no number, so Maya skips it.',
  )
})

test("transfers: only the owner's contact, still without a number, says what happens until it has one", () => {
  const owner = contact('Owner', { id: 'person', number: '' })
  const who = (you: boolean) => (c: TransferDraft) => (c.id === 'person' ? { name: 'Mike Brennan', you } : null)
  expect(all(transfersSummary({ ...transfers, transfers: [owner], who: who(true) }))).toBe(
    'Maya takes a message for now. Callers who ask for a person reach you once your mobile number is in.',
  )
  expect(all(transfersSummary({ ...transfers, transfers: [owner], who: who(false) }))).toBe(
    'Maya takes a message for now. Callers who ask for a person reach Mike Brennan once their number is in.',
  )
  // With a number, the owner's name in place of "Owner".
  expect(
    all(transfersSummary({ ...transfers, transfers: [{ ...owner, number: '+15035550142' }], who: who(true) })),
  ).toContain('Maya puts callers through to Mike Brennan when the condition fits.')
})

const notify = {
  email: true,
  assigned: false,
  setupEmails: false,
  device: null,
  otherDevices: 0,
  pushSummary: true,
  brand: 'Linedesk',
} as const

test('notifications: what you get and how', () => {
  expect(all(notificationsSummary(notify))).toBe('You get an email for every call.')
  expect(all(notificationsSummary({ ...notify, assigned: true, device: 'push' }))).toBe(
    'You get an email for every call, an email when a call is assigned to you, and push notifications on this device. Push notifications say what the call was about.',
  )
  expect(all(notificationsSummary({ ...notify, email: false, device: 'open', pushSummary: false }))).toBe(
    'You get notifications on this device while Linedesk is open.',
  )
  expect(all(notificationsSummary({ ...notify, otherDevices: 2, pushSummary: false }))).toBe(
    'You get an email for every call and push notifications on 2 other devices.',
  )
  expect(all(notificationsSummary({ ...notify, email: false }))).toBe('You get no notifications.')
})

test('rules: the demo defaults', () => {
  const behaviours = {
    ask_name: true,
    offer_callback: true,
    confirm_number: false,
    caller_history: true,
    ask_booking_name: false,
    verified_caller_only: true,
  }
  expect(all(rulesSummary({ name: 'Maya', style: 'standard', disclosure: 'when_asked', behaviours }))).toBe(
    "Maya speaks in its standard tone and says it is an AI only when asked. Maya asks for the caller's name, offers a callback when it can't answer, knows the caller's previous calls, and recognizes callers only when their carrier verified the number.",
  )
})

test('rules: another tone, AI at the start, every switch off', () => {
  const off = {
    ask_name: false,
    offer_callback: false,
    confirm_number: false,
    caller_history: false,
    ask_booking_name: false,
    verified_caller_only: false,
  }
  const s = rulesSummary({ name: 'Maya', style: 'formal', disclosure: 'at_start_consent', behaviours: off })
  expect(all(s)).toBe(
    'Maya sounds formal and factual and says at the start that it is an AI and asks the caller to agree. All switches of the checklist are off.',
  )
  expect(s.needsYou).toBeNull()
})

test('rules: the AI disclosure modes that do not say it on their own', () => {
  const off = {
    ask_name: false,
    offer_callback: false,
    confirm_number: false,
    caller_history: false,
    ask_booking_name: false,
    verified_caller_only: false,
  }
  expect(
    all(rulesSummary({ name: 'Maya', style: 'standard', disclosure: 'never_confirm', behaviours: off })),
  ).toContain('never says it is an AI, not even when asked')
  expect(all(rulesSummary({ name: 'Maya', style: 'standard', disclosure: 'never', behaviours: off }))).toContain(
    "doesn't bring up that it is an AI",
  )
})
