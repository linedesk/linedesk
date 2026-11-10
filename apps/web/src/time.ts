/** Postgres sends "2026-11-10 12:00:00+00", actions write ISO. Parse both. */
export function parseTs(value: string): Date {
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  return new Date(iso)
}

export function dayLabel(date: Date, now = new Date()): 'Today' | 'Yesterday' | 'Earlier' {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier'
}

export function timeLabel(date: Date, now = new Date()): string {
  const day = dayLabel(date, now)
  if (day === 'Today') return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (day === 'Yesterday') return 'Yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** A row's time under a day label ("Today", "Yesterday"): the clock time, so the day is not said twice. */
export function timeUnderDay(date: Date, now = new Date()): string {
  return dayLabel(date, now) === 'Yesterday'
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : timeLabel(date, now)
}

/** "1m 20s" for lists. */
export function shortDuration(seconds: number): string {
  const m = Math.floor(seconds / 60),
    s = Math.round(seconds % 60)
  return m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`
}

/** "1 min 20 sec" for the call header. */
export function longDuration(seconds: number): string {
  const m = Math.floor(seconds / 60),
    s = Math.round(seconds % 60)
  return m ? `${m} min${s ? ` ${s} sec` : ''}` : `${s} sec`
}

/** "01:20" for clocks and transcript times. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** "10:23 AM", "Yesterday 10:23 AM" or "Nov 8, 10:23 AM" for the call header. */
export function dateTimeLabel(date: Date, now = new Date()): string {
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const day = dayLabel(date, now)
  if (day === 'Today') return time
  return day === 'Yesterday'
    ? `Yesterday ${time}`
    : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

/** When a reminder comes back: "Today 6:30 PM", "Tomorrow 8:00 AM", "Fri 8:00 AM", "Dec 10, 8:00 AM". */
export function whenLabel(date: Date, now = new Date()): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000)
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days > 1 && days < 7) return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}
