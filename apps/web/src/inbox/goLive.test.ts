import type { GoLiveChecklistData, GoLiveStepState } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  calendarReady,
  firstCallHint,
  canSkipGoLiveStep,
  forwardedCallArrived,
  forwardingFacts,
  type GoLiveFacts,
  goLiveItems,
  goLiveProgress,
  goLiveSettled,
  goLiveShown,
  goLiveView,
  teamInvited,
} from './goLive.ts'

const none: GoLiveFacts = {
  voice: null,
  hasNumber: false,
  forwardingNumberId: 'none',
  forwardingTakesAllCalls: false,
  forwardingVerified: false,
  firstRealCall: false,
  calendarConnected: false,
  pushOn: false,
  teamInvited: false,
}
const all: GoLiveFacts = {
  ...none,
  hasNumber: true,
  forwardingVerified: true,
  firstRealCall: true,
  calendarConnected: true,
  pushOn: true,
  teamInvited: true,
}
const server = (over: Partial<GoLiveChecklistData> = {}): GoLiveChecklistData => ({
  shown: true,
  forwardingVerified: false,
  firstRealCall: false,
  dismissed: false,
  ...over,
})

const NOW = new Date('2026-11-13T12:00:00Z')
const progress = (items: ReturnType<typeof goLiveItems>, steps: GoLiveStepState[] = []) =>
  goLiveProgress(goLiveView(items, steps, NOW))
const skipped = (step: GoLiveStepState['step']): GoLiveStepState => ({ step, state: 'skipped', until: null })
const later = (step: GoLiveStepState['step'], days: number): GoLiveStepState => ({
  step,
  state: 'later',
  until: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
})

describe('go-live checklist', () => {
  test('six steps in setup order, each with where it is done', () => {
    const items = goLiveItems(none, 'Maya')
    expect(items.map(i => i.id)).toEqual(['number', 'forwarding', 'first_call', 'calendar', 'push', 'team'])
    expect(items.map(i => i.href)).toEqual([
      '#workspace/phone',
      '#workspace/phone',
      null,
      '#assistant/booking',
      '#account/notifications',
      '#workspace/team',
    ])
    expect(items[0]!.hint).toContain('Maya')
    expect(progress(items)).toBe('0 of 6')
  })

  test('each fact ticks its own row', () => {
    const items = goLiveItems({ ...none, hasNumber: true, calendarConnected: true }, 'Maya')
    expect(items.filter(i => i.done).map(i => i.id)).toEqual(['number', 'calendar'])
    expect(progress(items)).toBe('2 of 6')
  })

  test("the forwarding row opens the forwarding number's codes, and is left out when no number forwards", () => {
    expect(goLiveItems({ ...none, hasNumber: true, forwardingNumberId: 'pn_1' }, 'Maya')[1]!.href).toBe(
      '#workspace/phone/pn_1',
    )
    const direct = goLiveItems({ ...none, hasNumber: true, forwardingNumberId: null }, 'Maya')
    expect(direct.map(i => i.id)).not.toContain('forwarding')
    const numbers = [
      {
        id: 'pn_new',
        mode: 'new' as const,
        created_at: '2026-11-01T00:00:00Z',
      },
      {
        id: 'pn_fwd',
        mode: 'forward_all' as const,
        created_at: '2026-11-02T00:00:00Z',
      },
    ]
    expect(forwardingFacts([]).forwardingNumberId).toBe('none')
    expect(forwardingFacts(numbers)).toEqual({ forwardingNumberId: 'pn_fwd', forwardingTakesAllCalls: true })
    expect(forwardingFacts([numbers[0]!]).forwardingNumberId).toBeNull()
  })

  test('the forwarding row says every call when the number takes all calls, the missed ones otherwise', () => {
    const conditional = forwardingFacts([
      { id: 'pn_1', mode: 'forward_conditional', created_at: '2026-11-01T00:00:00Z' },
    ])
    expect(conditional.forwardingTakesAllCalls).toBe(false)
    const hint = (facts: Partial<GoLiveFacts>) =>
      goLiveItems({ ...none, hasNumber: true, ...facts }, 'Maya').find(i => i.id === 'forwarding')!.hint
    expect(hint(conditional)).toBe('Calls you miss go to Maya')
    expect(hint({ forwardingNumberId: 'pn_1', forwardingTakesAllCalls: true })).toBe('Every call goes to Maya')
  })

  test('without a calendar provider on the install there is no calendar row', () => {
    const items = goLiveItems({ ...none, calendarConnected: null }, 'Maya')
    expect(items.map(i => i.id)).toEqual(['number', 'forwarding', 'first_call', 'push', 'team'])
    expect(progress(items)).toBe('0 of 5')
  })

  test("push is the viewer's own step, everything else the workspace's", () => {
    const items = goLiveItems(none, 'Maya')
    expect(items.filter(i => i.scope === 'person').map(i => i.id)).toEqual(['push'])
    expect(canSkipGoLiveStep('push')).toBe(true)
    // The viewer's own "Not needed" for push hides it (the server only sends the viewer's own person-scoped rows).
    const view = goLiveView(items, [skipped('push')], NOW)
    expect(view.skipped.map(i => i.id)).toEqual(['push'])
    // Undo / bring back: without the row it is open again.
    expect(goLiveView(items, [], NOW).open.map(i => i.id)).toContain('push')
  })

  test('a real call to a forwarded number proves forwarding works', () => {
    const numbers = [
      { e164: '+15035550142', mode: 'forward_conditional' as const },
      { e164: '+15035550199', mode: 'new' as const },
    ]
    const call = {
      source: 'phone' as const,
      from_own_number: false,
      outcome: 'message' as const,
      to_number: '+15035550142',
    }
    expect(forwardedCallArrived([call], numbers)).toBe(true)
    expect(forwardedCallArrived([{ ...call, from_own_number: true }], numbers)).toBe(false)
    expect(forwardedCallArrived([{ ...call, source: 'test' }], numbers)).toBe(false)
    expect(forwardedCallArrived([{ ...call, to_number: '+15035550199' }], numbers)).toBe(false)
  })

  test('a calendar counts once it works and the assistant uses one of its calendars', () => {
    expect(calendarReady([{ id: 'c1', status: 'connected' }], [{ connection_id: 'c1' }])).toBe(true)
    expect(calendarReady([{ id: 'c1', status: 'needs_reconnect' }], [{ connection_id: 'c1' }])).toBe(false)
    expect(calendarReady([{ id: 'c1', status: 'connected' }], [])).toBe(false)
  })

  test('an expired invitation is not a team', () => {
    const member = { user_id: 'u1' } as never
    const invitation = (expired: boolean) => ({ expired }) as never
    expect(teamInvited({ members: [member], invitations: [invitation(true)] })).toBe(false)
    expect(teamInvited({ members: [member], invitations: [invitation(false)] })).toBe(true)
    expect(teamInvited({ members: [member, member], invitations: [] })).toBe(true)
  })

  test('without push on the install there is no push row', () => {
    const items = goLiveItems({ ...none, pushOn: null }, 'Maya')
    expect(items.map(i => i.id)).not.toContain('push')
    expect(progress(items)).toBe('0 of 5')
  })

  test('shown after onboarding until everything is done or it was closed', () => {
    const open = goLiveItems(none, 'Maya')
    expect(goLiveShown(server(), open)).toBe(true)
    expect(goLiveShown(undefined, open)).toBe(false) // not loaded, or a member
    expect(goLiveShown(server({ shown: false }), open)).toBe(false) // a workspace from before onboarding
    expect(goLiveShown(server({ dismissed: true }), open)).toBe(false)
    expect(goLiveShown(server(), goLiveItems(all, 'Maya'))).toBe(false)
    expect(goLiveShown(server(), goLiveItems(all, 'Maya'), true)).toBe(true) // opened again from ⌘K
    expect(goLiveShown(server({ dismissed: true }), open, true)).toBe(false)
  })

  test('a step marked not needed counts as handled; done wins over skipped', () => {
    const items = goLiveItems({ ...all, teamInvited: false, calendarConnected: false }, 'Maya')
    expect(progress(items)).toBe('4 of 6')
    expect(progress(items, [skipped('team')])).toBe('5 of 6 (1 not needed)')
    expect(progress(items, [skipped('team'), skipped('calendar')])).toBe('6 of 6 (2 not needed)')
    // A skipped step that got done anyway is done, not skipped.
    expect(progress(goLiveItems(all, 'Maya'), [skipped('team')])).toBe('6 of 6')
    // The number and the first real call are never skipped, even if a row says so (an old row from before).
    const view = goLiveView(goLiveItems(none, 'Maya'), [skipped('first_call'), skipped('number')], NOW)
    expect(view.open.map(i => i.id)).toEqual(expect.arrayContaining(['number', 'first_call']))
    expect(view.skipped).toEqual([])
    expect(canSkipGoLiveStep('number')).toBe(false)
    expect(canSkipGoLiveStep('first_call')).toBe(false)
    // Later still works for the number.
    expect(goLiveView(goLiveItems(none, 'Maya'), [later('number', 3)], NOW).later.map(l => l.item.id)).toEqual([
      'number',
    ])
  })

  test('a later step leaves the open steps until its date, earliest first', () => {
    const items = goLiveItems(none, 'Maya')
    const view = goLiveView(items, [later('team', 30), later('calendar', 3)], NOW)
    expect(view.open.map(i => i.id)).toEqual(['number', 'forwarding', 'first_call', 'push'])
    expect(view.later.map(l => l.item.id)).toEqual(['calendar', 'team'])
    expect(progress(items, [later('team', 30)])).toBe('0 of 6') // put off is not handled
    // Its date passed: open again.
    expect(goLiveView(items, [later('team', -1)], NOW).open.map(i => i.id)).toContain('team')
  })

  test('finished when every step is done or not needed; only later steps left hides it until the first comes back', () => {
    const rest = goLiveItems({ ...all, teamInvited: false, calendarConnected: false }, 'Maya')
    const steps = (s: GoLiveStepState[]) => server({ steps: s })
    expect(goLiveShown(steps([]), rest, false, NOW)).toBe(true)
    expect(goLiveShown(steps([skipped('team'), skipped('calendar')]), rest, false, NOW)).toBe(false)
    expect(goLiveShown(steps([skipped('team'), later('calendar', 3)]), rest, false, NOW)).toBe(false)
    const back = new Date(NOW.getTime() + 3 * 86_400_000 + 1)
    expect(goLiveShown(steps([skipped('team'), later('calendar', 3)]), rest, false, back)).toBe(true)
    // ⌘K still opens it.
    expect(goLiveShown(steps([skipped('team'), skipped('calendar')]), rest, true, NOW)).toBe(true)
    // An answer from an API of the release before has no steps: as before.
    expect(goLiveShown(server(), rest, false, NOW)).toBe(true)
  })

  test('settled answers are not read again on their own', () => {
    expect(goLiveSettled(undefined)).toBe(false)
    expect(goLiveSettled(server())).toBe(false)
    expect(goLiveSettled(server({ shown: false }))).toBe(true)
    expect(goLiveSettled(server({ dismissed: true }))).toBe(true)
    expect(goLiveSettled(server({ forwardingVerified: true }))).toBe(false)
    expect(goLiveSettled(server({ forwardingVerified: true, firstRealCall: true }))).toBe(true)
  })

  test('the voice service is the first step where it is not set up; admins get the link, members whom to ask', () => {
    const admin = goLiveItems({ ...none, voice: { ready: false, failing: false, canFix: true } }, 'Maya')
    expect(admin[0]).toMatchObject({
      id: 'voice',
      label: 'Maya can answer calls',
      done: false,
      href: '#admin/providers',
    })
    expect(admin[0]!.hint).toBe(
      "Maya can't answer calls yet: the voice service isn't set up. Set it up under Admin › Providers.",
    )
    const member = goLiveItems({ ...none, voice: { ready: false, failing: false, canFix: false } }, 'Maya')
    expect(member[0]).toMatchObject({ href: null, hint: expect.stringContaining('Ask whoever runs this server.') })
    expect(goLiveItems({ ...none, voice: { ready: true, failing: false, canFix: false } }, 'Maya')[0]!.done).toBe(true)
    // Set up but failing (a used-up quota): not done, and the hint says so, in the header's words.
    const failing = goLiveItems({ ...none, voice: { ready: true, failing: true, canFix: true } }, 'Maya')[0]!
    expect(failing).toMatchObject({ id: 'voice', done: false, href: '#admin/providers' })
    expect(failing.hint).toBe(
      "Maya can't answer calls: a service it needs is failing (a used-up quota or a rejected key). Fix it under Admin › Providers.",
    )
    expect(goLiveItems(none, 'Maya')[0]!.id).toBe('number')
    expect(canSkipGoLiveStep('voice')).toBe(false)
  })

  test('the first-call hint names the assistant', () => {
    expect(firstCallHint('Maya')).toMatch(/^When someone calls, Maya answers/)
  })
})
