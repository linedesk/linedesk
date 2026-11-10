import { describe, expect, it } from 'vitest'
import { reminderOptions } from './remind.ts'

describe('reminder times', () => {
  const tuesdayAfternoon = new Date(2026, 10, 10, 15, 30)
  const at = (label: string) => reminderOptions(tuesdayAfternoon).find(o => o.label === label)!.at

  it('offers later today, mornings at 8 and the next Monday', () => {
    expect(at('Later today')).toEqual(new Date(2026, 10, 10, 18, 30))
    expect(at('Tomorrow morning')).toEqual(new Date(2026, 10, 11, 8))
    expect(at('In two days')).toEqual(new Date(2026, 10, 12, 8))
    expect(at('Next week')).toEqual(new Date(2026, 10, 16, 8))
    expect(at('In a month')).toEqual(new Date(2026, 11, 10, 8))
  })
  it('goes to the following Monday when today is Monday', () => {
    const monday = new Date(2026, 10, 9, 9)
    expect(reminderOptions(monday).find(o => o.label === 'Next week')!.at).toEqual(new Date(2026, 10, 16, 8))
  })
})

describe('reminder edge cases', () => {
  const at = (now: Date, label: string) => reminderOptions(now).find(o => o.label === label)?.at
  it('clamps "In a month" to the end of a shorter month', () => {
    expect(at(new Date(2027, 0, 31, 10), 'In a month')).toEqual(new Date(2027, 1, 28, 8))
    expect(at(new Date(2028, 0, 31, 10), 'In a month')).toEqual(new Date(2028, 1, 29, 8)) // leap year
    expect(at(new Date(2026, 11, 15, 10), 'In a month')).toEqual(new Date(2027, 0, 15, 8))
  })
  it('does not offer "Later today" once that would be tomorrow', () => {
    expect(at(new Date(2026, 10, 10, 20, 59), 'Later today')).toEqual(new Date(2026, 10, 10, 23, 59))
    expect(at(new Date(2026, 10, 10, 21, 0), 'Later today')).toBeUndefined()
    expect(reminderOptions(new Date(2026, 10, 10, 22)).map(o => o.label)).toEqual(['Tomorrow morning', 'In two days', 'Next week', 'In a month'])
  })
})

describe('reminder menu', () => {
  it('shows the actual time next to each label', () => {
    const options = reminderOptions(new Date(2026, 10, 10, 15, 30))
    expect(options.map(o => [o.label, o.hint])).toEqual([
      ['Later today', 'Today 6:30 PM'], ['Tomorrow morning', 'Tomorrow 8:00 AM'], ['In two days', 'Thu 8:00 AM'], ['Next week', 'Mon 8:00 AM'], ['In a month', 'Dec 10, 8:00 AM'],
    ])
  })
})
