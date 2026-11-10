// The times offered by "Remind me" (H). Mornings are 8:00 local time.
export type ReminderOption = { label: string; icon: 'calendar'; at: Date }

const MORNING_HOUR = 8
const LATER_TODAY_HOURS = 3

function morning(now: Date, daysAhead: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, MORNING_HOUR)
}

/** Same day next month; the last day of that month when it is shorter (Jan 31 gives Feb 28). */
function inAMonth(now: Date): Date {
  const lastDayNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate()
  return new Date(now.getFullYear(), now.getMonth() + 1, Math.min(now.getDate(), lastDayNextMonth), MORNING_HOUR)
}

export function reminderOptions(now = new Date()): ReminderOption[] {
  const laterToday = new Date(now.getTime() + LATER_TODAY_HOURS * 3_600_000)
  const daysToMonday = (8 - now.getDay()) % 7 || 7
  const times: [string, Date][] = [
    ...(laterToday.getDate() === now.getDate() ? [['Later today', laterToday] satisfies [string, Date]] : []), // not offered once it would be tomorrow
    ['Tomorrow morning', morning(now, 1)],
    ['In two days', morning(now, 2)],
    ['Next week', morning(now, daysToMonday)],
    ['In a month', inAMonth(now)],
  ]
  return times.map(([label, at]) => ({ label, icon: 'calendar', at }))
}
