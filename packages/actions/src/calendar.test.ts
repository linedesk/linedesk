import { describe, expect, it } from 'vitest'
import { actions, appointmentBook, appointmentCancel, appointmentReschedule, applyLocally, CALLER_NAME_MAX, calendarFindSlots, callFinish, type LocalTables, rolePermissions, type Role } from './index.ts'

describe('calendar.findSlots', () => {
  it('is in the registry as a read-only action without an optimistic patch', () => {
    expect(actions.get('calendar.findSlots')).toBe(calendarFindSlots)
    expect(calendarFindSlots.readOnly).toBe(true)
    expect(calendarFindSlots.patch).toBeUndefined()
  })

  it('is read-only, like the other reads, tests and proposals that change nothing', () => {
    expect([...actions.values()].filter(a => a.readOnly).map(a => a.name).sort()).toEqual(['apiKey.list', 'assistant.startTestCall', 'assistant.version', 'assistant.versions', 'business.import', 'business.search', 'calendar.findSlots', 'calendar.listCalendars', 'calendarTools.get', 'call.askWebhook', 'call.export', 'call.findForTest', 'call.getEvaluation', 'call.listEvaluations', 'call.listNumbers', 'call.listen', 'call.lookUpCaller', 'call.takeOver', 'carrier.get', 'carrier.test', 'carrier.transferTrunk', 'evaluation.listQuestions', 'holidays.lookup', 'impersonationEmails.get', 'insights.get', 'invitation.listMine', 'knowledge.import', 'member.list', 'notifications.get', 'onboarding.goLiveChecklist', 'outbound.countries', 'outboundCountries.get', 'phoneNumber.forwardingCheck', 'phoneNumber.listCarrierNumbers', 'phoneNumber.lookupLine', 'provider.confirmEmail', 'provider.test', 'provider.tryOut', 'setupEmails.get', 'team.getMember', 'team.list', 'voice.catalog', 'voice.options', 'voiceCloning.get', 'voicePipelinePolicy.get', 'webhook.deliveries', 'webhook.test', 'workspace.deletePreview', 'workspace.getSettings'])
  })

  it.each(['owner', 'admin', 'member'] satisfies Role[])('can be called by %s', role => {
    expect(rolePermissions[role]).toContain(calendarFindSlots.permission)
  })

  it('can be called by the voice agent within its workspace', () => {
    expect(calendarFindSlots.agent).toBe('workspace')
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
    for (const name of ['calendar.connectStart', 'calendar.connectFinish', 'calendar.connectWithPassword', 'calendar.listCalendars', 'calendar.disconnect', 'assistantCalendar.add', 'assistantCalendar.update', 'assistantCalendar.setDefault', 'assistantCalendar.remove']) {
      const def = actions.get(name)!
      expect(def.permission, name).toBe('settings:write')
      expect(rolePermissions.member).not.toContain(def.permission)
      expect(rolePermissions.agent).not.toContain(def.permission)
    }
  })

  it('the OAuth code and a CalDAV password are redacted in the command log', () => {
    expect(actions.get('calendar.connectFinish')!.sensitive).toEqual(['code'])
    expect(actions.get('calendar.connectWithPassword')!.sensitive).toEqual(['password'])
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

  it('connectStart takes Google or Microsoft only; a password connect only a password provider', () => {
    expect(actions.get('calendar.connectStart')!.input.safeParse({ provider: 'yahoo' }).success).toBe(false)
    expect(actions.get('calendar.connectStart')!.input.safeParse({ provider: 'caldav' }).success).toBe(false)
    const login = { serverUrl: 'https://caldav.icloud.com', username: 'mike@brightwater.example', password: 'abcd-efgh-ijkl-mnop' }
    expect(actions.get('calendar.connectWithPassword')!.input.safeParse({ provider: 'caldav', ...login }).success).toBe(true)
    expect(actions.get('calendar.connectWithPassword')!.input.safeParse({ provider: 'google', ...login }).success).toBe(false)
    // HTTP Basic: a colon ends the user name, control characters break the header.
    for (const username of ['mike:admin', 'mike\nX: 1', 'mike\u0000'])
      expect(actions.get('calendar.connectWithPassword')!.input.safeParse({ provider: 'caldav', ...login, username }).success, username).toBe(false)
    expect(actions.get('calendar.connectWithPassword')!.input.safeParse({ provider: 'caldav', ...login, password: 'a\r\nb' }).success).toBe(false)
  })
})

describe('caller names', () => {
  const book = { appointmentTypeId: 'at_1', calendarId: 'ac_1', start: '2026-03-09T17:00:00Z', reason: 'Leak' }
  const tooLong = 'n'.repeat(CALLER_NAME_MAX + 1)

  it(`are capped at ${CALLER_NAME_MAX} characters in every action that takes one`, () => {
    expect(appointmentBook.input.safeParse({ ...book, callerName: 'n'.repeat(CALLER_NAME_MAX) }).success).toBe(true)
    expect(appointmentBook.input.safeParse({ ...book, callerName: tooLong }).success).toBe(false)
    for (const [action, input] of [
      [appointmentCancel, { callId: 'c_1', bookingDate: '2026-03-09' }],
      [appointmentReschedule, { callId: 'c_1', bookingDate: '2026-03-09', start: book.start }],
    ] as const) {
      expect(action.input.safeParse({ ...input, bookedName: 'Sam Patel' }).success).toBe(true)
      expect(action.input.safeParse({ ...input, bookedName: tooLong }).success).toBe(false)
    }
    expect(callFinish.input.safeParse({ callId: 'c_1', callerName: tooLong }).success).toBe(false)
  })

  it('the summary may still find no name', () => {
    expect(callFinish.input.parse({ callId: 'c_1', callerName: '  ' })).toEqual({ callId: 'c_1', callerName: '' })
  })
})
