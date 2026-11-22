import type { GoLiveChecklistData, GoLiveStepState } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  calendarReady,
  canSkipGoLiveStep,
  firstCallHint,
  forwardedCallArrived,
  forwardingFacts,
  type GoLiveFacts,
  goLiveItems,
  goLiveProgress,
  goLiveSettled,
  goLiveShown,
  goLiveView,
  nextGoLiveStep,
  presenceSaidByChecklist,
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
  businessKind: null,
  shopifyConnected: false,
  jobberConnected: false,
  mailboxConnected: false,
  faqReviewed: false,
}
const all: GoLiveFacts = {
  ...none,
  hasNumber: true,
  forwardingVerified: true,
  firstRealCall: true,
  calendarConnected: true,
  pushOn: true,
  teamInvited: true,
  shopifyConnected: true,
  jobberConnected: true,
  mailboxConnected: true,
  faqReviewed: true,
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

  test('a real call to the forwarded setup number since it was set up proves forwarding works (the server rule)', () => {
    const numbers = [
      { id: 'n1', e164: '+15035550142', mode: 'forward_conditional' as const, created_at: '2026-11-10T09:00:00.000Z' },
      { id: 'n2', e164: '+15035550199', mode: 'new' as const, created_at: '2026-11-11T09:00:00.000Z' },
    ]
    const call = {
      source: 'phone' as const,
      direction: 'in' as const,
      from_own_number: false,
      outcome: 'message' as const,
      to_number: '+15035550142',
      started_at: '2026-11-12T15:00:00.000Z',
    }
    expect(forwardedCallArrived([call], numbers)).toBe(true)
    expect(forwardedCallArrived([{ ...call, from_own_number: true }], numbers)).toBe(false)
    expect(forwardedCallArrived([{ ...call, source: 'test' }], numbers)).toBe(false)
    expect(forwardedCallArrived([{ ...call, to_number: '+15035550199' }], numbers)).toBe(false)
    // Outgoing, spam, or before the number was set up: not a forwarded caller.
    expect(forwardedCallArrived([{ ...call, direction: 'out' }], numbers)).toBe(false)
    expect(forwardedCallArrived([{ ...call, outcome: 'spam' }], numbers)).toBe(false)
    expect(forwardedCallArrived([{ ...call, started_at: '2026-11-09T15:00:00.000Z' }], numbers)).toBe(false)
    // No number forwards: nothing to prove.
    expect(forwardedCallArrived([call], [{ ...numbers[0]!, mode: 'new' }])).toBe(false)
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

  test('the voice service is the first step where it is not set up; admins get the link, nobody else is sent to ask anyone', () => {
    const admin = goLiveItems({ ...none, voice: { ready: false, failing: false, canFix: true } }, 'Maya')
    expect(admin[0]).toMatchObject({
      id: 'voice',
      label: 'Maya can answer calls',
      done: false,
      href: '#admin/providers/answering',
    })
    expect(admin[0]!.hint).toBe(
      "Maya can't answer calls yet: the voice service isn't set up. Set it up under Server admin › Providers.",
    )
    const member = goLiveItems({ ...none, voice: { ready: false, failing: false, canFix: false } }, 'Maya')
    expect(member[0]).toMatchObject({
      href: null,
      hint: "Maya can't answer calls yet: the voice service isn't set up. Nothing for you to do: it starts working on its own.",
    })
    // Owners who are not instance admins can't act on it either: no "ask whoever runs this server", no "server" at all.
    for (const voice of [
      { ready: false, failing: false },
      { ready: true, failing: true },
    ])
      expect(goLiveItems({ ...none, voice: { ...voice, canFix: false } }, 'Maya')[0]!.hint).not.toMatch(/server|ask/i)
    expect(goLiveItems({ ...none, voice: { ready: true, failing: false, canFix: false } }, 'Maya')[0]!.done).toBe(true)
    // Set up but failing (a used-up quota): not done, and the hint says so, in the header's words.
    const failing = goLiveItems({ ...none, voice: { ready: true, failing: true, canFix: true } }, 'Maya')[0]!
    expect(failing).toMatchObject({ id: 'voice', done: false, href: '#admin/providers/answering' })
    expect(failing.hint).toBe(
      "Maya can't answer calls: a service it needs is failing (a used-up quota or a rejected key). Fix it under Server admin › Providers.",
    )
    expect(goLiveItems(none, 'Maya')[0]!.id).toBe('number')
    expect(canSkipGoLiveStep('voice')).toBe(false)
  })

  test('the collapsed card names the first step the viewer can act on', () => {
    const items = goLiveItems({ ...none, voice: { ready: false, failing: false, canFix: false } }, 'Maya')
    expect(items[0]!.id).toBe('voice')
    expect(nextGoLiveStep(goLiveView(items, [], NOW))?.id).toBe('number')
    const admin = goLiveItems({ ...none, voice: { ready: false, failing: false, canFix: true } }, 'Maya')
    expect(nextGoLiveStep(goLiveView(admin, [], NOW))?.id).toBe('voice')
    expect(nextGoLiveStep({ open: [] })).toBeUndefined()
  })

  test('the first-call hint names the assistant', () => {
    expect(firstCallHint('Maya')).toMatch(/^When someone calls, Maya answers/)
  })
})

test('the header leaves out why the assistant cannot answer while the checklist steps say it', () => {
  for (const reason of ['number', 'voice', 'failing'] as const) {
    expect(presenceSaidByChecklist({ kind: 'notAnswering', reason }, true)).toBe(true)
    expect(presenceSaidByChecklist({ kind: 'notAnswering', reason }, false)).toBe(false)
  }
  // Not a checklist step: always in the header.
  expect(presenceSaidByChecklist({ kind: 'answering' }, true)).toBe(false)
  expect(presenceSaidByChecklist({ kind: 'offline' }, true)).toBe(false)
  expect(presenceSaidByChecklist({ kind: 'unknown' }, true)).toBe(false)
})

describe('steps for the kind of business (LIN-680)', () => {
  const ids = (facts: Partial<GoLiveFacts>) => goLiveItems({ ...none, ...facts }, 'Maya').map(i => i.id)

  test('without a kind: the steps every workspace had, nothing new', () => {
    expect(ids({})).toEqual(['number', 'forwarding', 'first_call', 'calendar', 'push', 'team'])
  })

  test('an online store: Shopify, the support mailbox and its FAQ, no calendar', () => {
    expect(ids({ businessKind: 'online_store' })).toEqual([
      'number',
      'forwarding',
      'first_call',
      'shopify',
      'support_email',
      'faq',
      'push',
      'team',
    ])
  })

  test('a trade: the calendar and Jobber; a law office: the calendar and the support mailbox', () => {
    expect(ids({ businessKind: 'plumbing_hvac' })).toContain('jobber')
    expect(ids({ businessKind: 'plumbing_hvac' })).not.toContain('shopify')
    expect(ids({ businessKind: 'law_office' })).toEqual(expect.arrayContaining(['calendar', 'support_email', 'faq']))
    expect(ids({ businessKind: 'restaurant' })).not.toContain('calendar')
  })

  test('the support mail steps open the page of the mailbox connected (Outlook only: Outlook), else Gmail', () => {
    const href = (facts: Partial<GoLiveFacts>) =>
      goLiveItems({ ...none, businessKind: 'online_store', ...facts }, 'Maya')
        .filter(i => i.id === 'support_email' || i.id === 'faq')
        .map(i => i.href)
    expect(href({})).toEqual(['#integrations/gmail', '#integrations/gmail'])
    expect(href({ mailboxConnected: true, mailboxProvider: 'microsoft' })).toEqual([
      '#integrations/outlook-mail',
      '#integrations/outlook-mail',
    ])
  })

  test('each new step ticks itself from its fact and can be marked not needed', () => {
    const items = goLiveItems({ ...none, businessKind: 'online_store', shopifyConnected: true }, 'Maya')
    expect(items.find(i => i.id === 'shopify')).toMatchObject({ done: true, href: '#integrations/shopify' })
    expect(items.find(i => i.id === 'faq')!.done).toBe(false)
    for (const id of ['shopify', 'jobber', 'support_email', 'faq'] as const) expect(canSkipGoLiveStep(id)).toBe(true)
  })

  test('the FAQ keeps the checklist read again only where it shows', () => {
    const live = { forwardingVerified: true, firstRealCall: true }
    expect(goLiveSettled(server({ ...live, businessKind: 'online_store', faqReviewed: false }))).toBe(false)
    expect(goLiveSettled(server({ ...live, businessKind: 'online_store', faqReviewed: true }))).toBe(true)
    expect(goLiveSettled(server({ ...live, businessKind: 'plumbing_hvac', faqReviewed: false }))).toBe(true)
  })
})
