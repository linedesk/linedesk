import { expect, test } from 'vitest'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import type { SummarySentence } from '../ui/SummaryCard.tsx'
import type { TransferDraft } from './assistantDraft.ts'
import { dayRows } from './businessHoursModel.ts'
import type { UpcomingDay } from './closedDaysModel.ts'
import { hoursSummary, nextClosedDay, notificationsSummary, type Summary, transfersSummary } from './summaryModel.ts'

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

test('hours: none set needs the owner; off says so', () => {
  const none = hoursSummary({ ...hours, days: dayRows([]) })
  expect(all(none)).toBe('No business hours: Maya answers every call the same way, at any time.')
  expect(text(none.needsYou)).toBe('Set your business hours so Maya can tell callers when you are open.')
  const off = hoursSummary({ ...hours, on: false })
  expect(all(off)).toBe('Business hours are off: Maya answers every call the same way, at any time.')
  expect(off.needsYou).toBeNull()
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
  expect(text(missing.needsYou)).toBe('Office has no number, so Maya skips it.')
  expect(all(missing)).toContain('Maya puts callers through to Mike Brennan when the condition fits.')
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
