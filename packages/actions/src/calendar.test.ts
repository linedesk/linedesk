import { describe, expect, it } from 'vitest'
import { actions, calendarFindSlots, rolePermissions, type Role } from './index.ts'

describe('calendar.findSlots', () => {
  it('is in the registry as a read-only action without an optimistic patch', () => {
    expect(actions.get('calendar.findSlots')).toBe(calendarFindSlots)
    expect(calendarFindSlots.readOnly).toBe(true)
    expect(calendarFindSlots.patch).toBeUndefined()
  })

  it('is read-only, like the provider connection test, the test-call token, team.list and the call-test lookup', () => {
    expect([...actions.values()].filter(a => a.readOnly).map(a => a.name).sort()).toEqual(['assistant.startTestCall', 'calendar.findSlots', 'call.findForTest', 'provider.test', 'team.list'])
  })

  it.each(['owner', 'admin', 'member', 'agent'] satisfies Role[])('can be called by %s', role => {
    expect(rolePermissions[role]).toContain(calendarFindSlots.permission)
  })

  it('needs only the appointment type and defaults the limit', () => {
    expect(calendarFindSlots.input.parse({ appointmentTypeId: 'at_1' })).toEqual({ appointmentTypeId: 'at_1', limit: 20 })
  })

  it('accepts a window with offsets', () => {
    const input = { appointmentTypeId: 'at_1', from: '2026-03-08T00:00:00-08:00', to: '2026-03-09T07:00:00Z', limit: 5 }
    expect(calendarFindSlots.input.parse(input)).toEqual(input)
  })

  it.each([
    [{}],
    [{ appointmentTypeId: '' }],
    [{ appointmentTypeId: 'at_1', from: '2026-03-08' }],
    [{ appointmentTypeId: 'at_1', to: 'tomorrow' }],
    [{ appointmentTypeId: 'at_1', limit: 0 }],
    [{ appointmentTypeId: 'at_1', limit: 201 }],
  ])('rejects %j', input => {
    expect(calendarFindSlots.input.safeParse(input).success).toBe(false)
  })
})
