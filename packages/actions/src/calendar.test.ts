import { describe, expect, it } from 'vitest'
import { actions, applyLocally, calendarFindSlots, type LocalTables, rolePermissions, type Role } from './index.ts'

describe('calendar.findSlots', () => {
  it('is in the registry as a read-only action without an optimistic patch', () => {
    expect(actions.get('calendar.findSlots')).toBe(calendarFindSlots)
    expect(calendarFindSlots.readOnly).toBe(true)
    expect(calendarFindSlots.patch).toBeUndefined()
  })

  it('is read-only, like the provider connection test, the test-call token, team.list, the call-test lookup, the workspace settings read, the own invitations, the key list, the webhook log and test send, the call evaluations and the voice options', () => {
    expect([...actions.values()].filter(a => a.readOnly).map(a => a.name).sort()).toEqual(['apiKey.list', 'assistant.startTestCall', 'calendar.findSlots', 'calendar.listCalendars', 'call.findForTest', 'call.getEvaluation', 'call.listEvaluations', 'invitation.listMine', 'notifications.get', 'provider.test', 'team.list', 'voice.options', 'voiceCloning.get', 'webhook.deliveries', 'webhook.test', 'workspace.getSettings'])
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

describe('calendar accounts and the assistant calendars', () => {
  it('only owners and admins connect, list, disconnect and change calendars', () => {
    for (const name of ['calendar.connectStart', 'calendar.connectFinish', 'calendar.listCalendars', 'calendar.disconnect', 'assistantCalendar.add', 'assistantCalendar.update', 'assistantCalendar.setDefault', 'assistantCalendar.remove']) {
      const def = actions.get(name)!
      expect(def.permission, name).toBe('settings:write')
      expect(rolePermissions.member).not.toContain(def.permission)
      expect(rolePermissions.agent).not.toContain(def.permission)
    }
  })

  it('the OAuth code is redacted in the command log', () => {
    expect(actions.get('calendar.connectFinish')!.sensitive).toEqual(['code'])
  })

  it('assistantCalendar.update applies the instruction and the switch locally, and nothing it was not given', () => {
    const tables = { assistant_calendars: new Map([['acal_1', { id: 'acal_1', instruction: 'old', enabled: true, is_default: true }]]) } as unknown as LocalTables
    const def = actions.get('assistantCalendar.update')!
    applyLocally(tables, def, def.input.parse({ assistantCalendarId: 'acal_1', instruction: '  Emergencies  ' }), '2030-01-01T00:00:00Z')
    expect(tables.assistant_calendars.get('acal_1')).toMatchObject({ instruction: 'Emergencies', enabled: true, is_default: true })
    applyLocally(tables, def, def.input.parse({ assistantCalendarId: 'acal_1', enabled: false }), '2030-01-01T00:00:00Z')
    expect(tables.assistant_calendars.get('acal_1')).toMatchObject({ instruction: 'Emergencies', enabled: false })
    expect(def.input.safeParse({ assistantCalendarId: 'acal_1', instruction: 'x'.repeat(301) }).success).toBe(false)
  })

  it('connectStart takes Google or Microsoft only', () => {
    expect(actions.get('calendar.connectStart')!.input.safeParse({ provider: 'yahoo' }).success).toBe(false)
  })
})
