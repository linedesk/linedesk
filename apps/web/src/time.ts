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

/** "1m 20s" for lists. */
export function shortDuration(seconds: number): string {
  const m = Math.floor(seconds / 60), s = seconds % 60
  return m ? `${m}m ${s}s` : `${s}s`
}
