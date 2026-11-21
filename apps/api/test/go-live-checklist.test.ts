// The go-live checklist's reads, dismissal and reopening (onboarding.goLiveChecklist, onboarding.dismissGoLiveChecklist,
// onboarding.reopenGoLiveChecklist): owners and admins only, the dismissal per member.
import { calls, golive_checklist_steps, mail_analyses, phone_numbers, setup_events } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

const checklist = async (who: Parameters<typeof act>[0]) => {
  const res = await act(who, 'onboarding.goLiveChecklist', {})
  expect(res.status).toBe(200)
  return res.body.data
}
/** A workspace without the helper's ready-made call (a real-looking call to its number would prove forwarding). */
async function workspace(name: string) {
  const ws = await createWorkspace(name)
  await db.delete(calls).where(eq(calls.workspace_id, ws.id))
  return ws
}
const forwardingVerified = (workspaceId: string) =>
  db.insert(setup_events).values({
    workspace_id: workspaceId,
    event: 'forwarding_verified',
    at: new Date().toISOString(),
  })

test('shown once onboarding is over; forwarding comes from the setup number, the first real call from the milestones', async () => {
  const ws = await workspace('Checklist Plumbing')
  expect(await checklist(ws.owner)).toEqual({
    shown: false,
    forwardingVerified: false,
    firstRealCall: false,
    dismissed: false,
    steps: [],
    businessKind: null,
    faqReviewed: false,
  })
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  expect((await checklist(ws.owner)).shown).toBe(true)

  // A number callers dial directly: a real call there says nothing about forwarding.
  await db.update(phone_numbers).set({ mode: 'new' }).where(eq(phone_numbers.e164, ws.number))
  const callId = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callId as string
  expect(callId).toBeTruthy()
  expect(await checklist(ws.owner)).toEqual({
    shown: true,
    forwardingVerified: false,
    firstRealCall: true,
    dismissed: false,
    steps: [],
    businessKind: null,
    faqReviewed: false,
  })
  // The forwarding_verified milestone alone is only for Server admin › Onboarding; the number's check is what counts.
  await forwardingVerified(ws.id)
  expect((await checklist(ws.owner)).forwardingVerified).toBe(false)
  await db.update(phone_numbers).set({ verified_at: new Date().toISOString() }).where(eq(phone_numbers.e164, ws.number))
  expect((await checklist(ws.owner)).forwardingVerified).toBe(true)
})

test('a milestone or a check from a previous number does not tick it for the new one', async () => {
  const ws = await workspace('Replaced Number Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  // The first number was checked (verified_at and the milestone), then released.
  await db.update(phone_numbers).set({ verified_at: new Date().toISOString() }).where(eq(phone_numbers.e164, ws.number))
  await forwardingVerified(ws.id)
  expect((await checklist(ws.owner)).forwardingVerified).toBe(true)
  await db.delete(phone_numbers).where(eq(phone_numbers.e164, ws.number))
  // Its replacement forwards too and was never checked.
  await db.insert(phone_numbers).values({
    id: `pn_${crypto.randomUUID().slice(0, 12)}`,
    workspace_id: ws.id,
    e164: randomNumber(),
    provider: 'dev',
    mode: 'forward_conditional',
  })
  expect((await checklist(ws.owner)).forwardingVerified).toBe(false)
})

test('a spam call or an outgoing call to the forwarding number proves nothing', async () => {
  const ws = await workspace('Spam Checklist Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  const callId = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callId as string
  await db.update(calls).set({ outcome: 'spam' }).where(eq(calls.id, callId))
  expect((await checklist(ws.owner)).forwardingVerified).toBe(false)
  await db.update(calls).set({ outcome: null, direction: 'out' }).where(eq(calls.id, callId))
  expect((await checklist(ws.owner)).forwardingVerified).toBe(false)
  await db.update(calls).set({ direction: 'in' }).where(eq(calls.id, callId))
  expect((await checklist(ws.owner)).forwardingVerified).toBe(true)
})

test("a real caller reaching a forwarded number proves forwarding; the owner's own phone does not", async () => {
  const ws = await workspace('Forwarded Checklist Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  const mobile = randomNumber()
  const owner = {
    id: 'owner',
    name: 'Owner',
    number: mobile,
    condition: 'The caller asks for a person',
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'message',
    enabled: true,
  }
  const saved = await act(ws.owner, 'assistant.update', {
    assistantId: ws.assistant.id,
    transfers: [owner],
  })
  expect(saved.status).toBe(200)
  await act(agent(), 'call.start', { from: mobile, to: ws.number })
  expect((await checklist(ws.owner)).forwardingVerified).toBe(false)
  await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  expect((await checklist(ws.owner)).forwardingVerified).toBe(true)
})

test('a workspace that skipped onboarding gets it too', async () => {
  const ws = await workspace('Skipped Checklist Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'skipped' })
  expect((await checklist(ws.owner)).shown).toBe(true)
})

test('closing and reopening are per member; members can neither read, close nor reopen it', async () => {
  const ws = await workspace('Dismiss Checklist Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  const admin = await addMember(ws.id, 'admin')
  expect((await act(ws.owner, 'onboarding.dismissGoLiveChecklist', {})).status).toBe(200)
  expect((await act(ws.owner, 'onboarding.dismissGoLiveChecklist', {})).status).toBe(200)
  expect((await checklist(ws.owner)).dismissed).toBe(true)
  expect((await checklist(admin)).dismissed).toBe(false)

  // ⌘K "Show go-live checklist" opens it again, for that member only.
  await act(admin, 'onboarding.dismissGoLiveChecklist', {})
  expect((await act(ws.owner, 'onboarding.reopenGoLiveChecklist', {})).status).toBe(200)
  expect((await act(ws.owner, 'onboarding.reopenGoLiveChecklist', {})).status).toBe(200)
  expect((await checklist(ws.owner)).dismissed).toBe(false)
  expect((await checklist(admin)).dismissed).toBe(true)

  const member = await addMember(ws.id, 'member')
  expect((await act(member, 'onboarding.goLiveChecklist', {})).status).toBe(403)
  expect((await act(member, 'onboarding.dismissGoLiveChecklist', {})).status).toBe(403)
  expect((await act(member, 'onboarding.reopenGoLiveChecklist', {})).status).toBe(403)
})

test("another workspace's milestones, calls and dismissals never show", async () => {
  const a = await workspace('Tenant A Checklist')
  const b = await workspace('Tenant B Checklist')
  await act(a.owner, 'onboarding.setStep', { step: 'done' })
  await act(b.owner, 'onboarding.setStep', { step: 'done' })
  await forwardingVerified(a.id)
  await act(agent(), 'call.start', { from: randomNumber(), to: a.number })
  await act(a.owner, 'onboarding.dismissGoLiveChecklist', {})
  expect(await checklist(b.owner)).toEqual({
    shown: true,
    forwardingVerified: false,
    firstRealCall: false,
    dismissed: false,
    steps: [],
    businessKind: null,
    faqReviewed: false,
  })
})

// Later and Not needed (onboarding.skipGoLiveStep, onboarding.remindGoLiveStep, onboarding.restoreGoLiveStep).
test('not needed is for the whole workspace, later only for whoever put it off; restore brings both back', async () => {
  const ws = await workspace('Steps Checklist Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  const admin = await addMember(ws.id, 'admin')
  expect((await checklist(ws.owner)).steps).toEqual([])

  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'team' })).status).toBe(200)
  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'team' })).status).toBe(200) // twice is fine
  expect((await checklist(admin)).steps).toEqual([{ step: 'team', state: 'skipped', until: null }])

  const before = Date.now()
  expect((await act(admin, 'onboarding.remindGoLiveStep', { step: 'calendar', days: 7 })).status).toBe(200)
  const adminSteps = (await checklist(admin)).steps as { step: string; state: string; until: string | null }[]
  const later = adminSteps.find(s => s.state === 'later')!
  expect(later.step).toBe('calendar')
  const days = (new Date(later.until!).getTime() - before) / 86_400_000
  expect(days).toBeGreaterThan(6.99)
  expect(days).toBeLessThan(7.01)
  // The owner does not see the admin's later step.
  expect((await checklist(ws.owner)).steps).toEqual([{ step: 'team', state: 'skipped', until: null }])
  // A second Later moves the date instead of adding a row.
  await act(admin, 'onboarding.remindGoLiveStep', { step: 'calendar', days: 3 })
  const again = ((await checklist(admin)).steps as { state: string }[]).filter(s => s.state === 'later')
  expect(again).toHaveLength(1)

  // The owner's restore of the calendar leaves the admin's own Later alone; the admin's restore clears it.
  await act(ws.owner, 'onboarding.restoreGoLiveStep', { step: 'calendar' })
  expect(((await checklist(admin)).steps as unknown[]).length).toBe(2)
  await act(admin, 'onboarding.restoreGoLiveStep', { step: 'calendar' })
  expect((await checklist(admin)).steps).toEqual([{ step: 'team', state: 'skipped', until: null }])
  // Restoring a skipped step brings it back for everyone.
  expect((await act(admin, 'onboarding.restoreGoLiveStep', { step: 'team' })).status).toBe(200)
  expect((await checklist(ws.owner)).steps).toEqual([])
})

test("not needed on a step about one's own devices (push) is only that person's; restore undoes only their own", async () => {
  const ws = await workspace('Push Steps Checklist Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  const admin = await addMember(ws.id, 'admin')
  const pushSkipped = [{ step: 'push', state: 'skipped', until: null }]

  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'push' })).status).toBe(200)
  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'push' })).status).toBe(200) // twice is fine
  expect((await checklist(ws.owner)).steps).toEqual(pushSkipped)
  expect((await checklist(admin)).steps).toEqual([])

  // The admin skips it too, and puts it off as well: their own rows beside the owner's.
  expect((await act(admin, 'onboarding.skipGoLiveStep', { step: 'push' })).status).toBe(200)
  expect((await act(admin, 'onboarding.remindGoLiveStep', { step: 'push', days: 3 })).status).toBe(200)
  expect(((await checklist(admin)).steps as { state: string }[]).map(s => s.state).sort()).toEqual(['later', 'skipped'])

  // The owner's Undo (restore) brings push back for the owner only.
  expect((await act(ws.owner, 'onboarding.restoreGoLiveStep', { step: 'push' })).status).toBe(200)
  expect((await checklist(ws.owner)).steps).toEqual([])
  expect(((await checklist(admin)).steps as unknown[]).length).toBe(2)
  await act(admin, 'onboarding.restoreGoLiveStep', { step: 'push' })
  expect((await checklist(admin)).steps).toEqual([])

  // A workspace step skipped next to it is still everyone's.
  await act(admin, 'onboarding.skipGoLiveStep', { step: 'calendar' })
  await act(admin, 'onboarding.skipGoLiveStep', { step: 'push' })
  expect((await checklist(ws.owner)).steps).toEqual([{ step: 'calendar', state: 'skipped', until: null }])
})

test('the voice service, the number and the first real call can be put off but never marked not needed; bad steps and days are refused', async () => {
  const ws = await workspace('First Call Steps Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'first_call' })).status).toBe(422)
  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'number' })).status).toBe(422)
  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'voice' })).status).toBe(422)
  // A skipped row for the number from before it became required is ignored: the step is open again.
  await db.insert(golive_checklist_steps).values({
    id: 'gls_old_number_skip',
    workspace_id: ws.id,
    step: 'number',
    state: 'skipped',
    user_id: null,
    until: null,
    by_user_id: 'someone',
  })
  expect((await checklist(ws.owner)).steps).toEqual([])
  expect((await act(ws.owner, 'onboarding.remindGoLiveStep', { step: 'number', days: 3 })).status).toBe(200)
  await act(ws.owner, 'onboarding.restoreGoLiveStep', { step: 'number' })
  expect((await act(ws.owner, 'onboarding.skipGoLiveStep', { step: 'nonsense' })).status).toBe(422)
  expect((await act(ws.owner, 'onboarding.remindGoLiveStep', { step: 'team', days: 5 })).status).toBe(422)
  expect((await act(ws.owner, 'onboarding.remindGoLiveStep', { step: 'first_call', days: 30 })).status).toBe(200)
  expect((await checklist(ws.owner)).steps).toEqual([expect.objectContaining({ step: 'first_call', state: 'later' })])
})

test('members can neither skip, put off nor restore a step; another workspace never sees them', async () => {
  const a = await workspace('Steps Tenant A')
  const b = await workspace('Steps Tenant B')
  await act(a.owner, 'onboarding.setStep', { step: 'done' })
  await act(b.owner, 'onboarding.setStep', { step: 'done' })
  const member = await addMember(a.id, 'member')
  expect((await act(member, 'onboarding.skipGoLiveStep', { step: 'team' })).status).toBe(403)
  expect((await act(member, 'onboarding.remindGoLiveStep', { step: 'team', days: 3 })).status).toBe(403)
  expect((await act(member, 'onboarding.restoreGoLiveStep', { step: 'team' })).status).toBe(403)
  await act(a.owner, 'onboarding.skipGoLiveStep', { step: 'push' })
  await act(a.owner, 'onboarding.remindGoLiveStep', { step: 'team', days: 3 })
  expect((await checklist(b.owner)).steps).toEqual([])
  // B's restore does not touch A's rows.
  await act(b.owner, 'onboarding.restoreGoLiveStep', { step: 'push' })
  expect(((await checklist(a.owner)).steps as unknown[]).length).toBe(2)
})

test('the kind of business and the reviewed FAQ come with the checklist (LIN-680)', async () => {
  const ws = await createWorkspace('Kind Tea Shop')
  await act(ws.owner, 'workspace.updateSettings', { businessKind: 'online_store' })
  expect(await checklist(ws.owner)).toMatchObject({ businessKind: 'online_store', faqReviewed: false })
  const analysis = (topics: object[]) =>
    db.insert(mail_analyses).values({
      id: `ma_${crypto.randomUUID().slice(0, 8)}`,
      workspace_id: ws.id,
      status: 'done',
      months: 12,
      topics: topics as never,
      requested_by: ws.owner.userId,
    })
  const topic = (review?: object) => ({
    title: 'Where is my order?',
    example: '',
    answer: 'Tracking link.',
    factsNeeded: [],
    conversations: 3,
    ...(review ? { review } : {}),
  })
  await analysis([topic()])
  expect((await checklist(ws.owner)).faqReviewed).toBe(false)
  await db.delete(mail_analyses).where(eq(mail_analyses.workspace_id, ws.id))
  await analysis([topic({ decision: 'dropped', at: new Date().toISOString(), by: ws.owner.userId })])
  expect((await checklist(ws.owner)).faqReviewed).toBe(true)
  // Only a kind from the list is stored.
  expect((await act(ws.owner, 'workspace.updateSettings', { businessKind: 'tea_shop' })).status).toBe(422)
})
