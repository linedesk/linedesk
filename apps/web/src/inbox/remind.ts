// The times offered by "Remind me" (H), and a time typed into it. Mornings are 8:00 local time.
import { whenLabel } from '../time.ts'
import { parseWhen } from './parseWhen.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'

/**
 * `hint` is the actual time, shown next to the label in the menu. `inline`: the label as it reads inside a sentence
 * ("Reminder set: tomorrow morning."); the label itself when it is a typed time.
 */
export type ReminderOption = { label: string; icon: 'calendar'; at: Date; hint: string; inline?: string }

const MORNING_HOUR = 8
const LATER_TODAY_HOURS = 3
/** "Later today" is only offered while it still lands in the working day. */
const END_OF_DAY_HOUR = 19

function morning(now: Date, daysAhead: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, MORNING_HOUR)
}

/** Same day next month; the last day of that month when it is shorter (Jan 31 gives Feb 28). */
function inAMonth(now: Date): Date {
  const lastDayNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate()
  return new Date(now.getFullYear(), now.getMonth() + 1, Math.min(now.getDate(), lastDayNextMonth), MORNING_HOUR)
}

type Choice = 'laterToday' | 'tomorrowMorning' | 'inTwoDays' | 'nextWeek' | 'inAMonth'

export function reminderOptions(now = new Date()): ReminderOption[] {
  const laterToday = new Date(now.getTime() + LATER_TODAY_HOURS * 3_600_000)
  const daysToMonday = (8 - now.getDay()) % 7 || 7
  const times: [Choice, Date][] = [
    ...(laterToday.getDate() === now.getDate() && laterToday.getHours() < END_OF_DAY_HOUR
      ? [['laterToday', laterToday] satisfies [Choice, Date]]
      : []), // not offered once it would be evening or tomorrow
    ['tomorrowMorning', morning(now, 1)],
    ['inTwoDays', morning(now, 2)],
    ['nextWeek', morning(now, daysToMonday)],
    ['inAMonth', inAMonth(now)],
  ]
  const { t } = i18n()
  // i18n-dynamic: inbox.remind.option.*
  // i18n-dynamic: inbox.remind.inline.*
  return times.map(([choice, at]) => ({
    label: t(`inbox.remind.option.${choice}`),
    inline: t(`inbox.remind.inline.${choice}`),
    icon: 'calendar',
    at,
    hint: whenLabel(at, now),
  }))
}

/** The reminder a typed time means ("fri 2pm"), or null when the text is not a time. */
export function typedReminder(text: string, now = new Date()): ReminderOption | null {
  const at = parseWhen(text, now)
  if (!at) return null
  const hint = fmt().dateTime(at, { weekday: 'long', month: 'short', day: 'numeric' })
  return { label: whenLabel(at, now), icon: 'calendar', at, hint }
}
