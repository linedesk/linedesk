// Setup milestones (setup_events): recorded once per workspace where they happen; the owner's own test calls never count as real calls.
import { phone_numbers, setup_events } from '@linedesk/db'
import { asc, eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, getCall, randomNumber } from './helpers.ts'

const eventsOf = async (id: string) =>
  (await db.select().from(setup_events).where(eq(setup_events.workspace_id, id)).orderBy(asc(setup_events.event))).map(
    e => e.event,
  )

const transferContact = (number: string) => ({
  id: 'owner',
  name: 'Owner',
  number,
  condition: 'The caller asks for a person',
  hours_only: false,
  ring_seconds: 25,
  if_no_answer: 'message',
  enabled: true,
})

const phoneCall = async (workspaceId: string, to: string, from: string, outcome: string) => {
  const callId = (await act(agent(), 'call.start', { from, to })).body.data.callId as string
  expect((await act(agent(workspaceId), 'call.finish', { callId, outcome })).status).toBe(200)
  return callId
}

test('a new workspace has signed up; onboarding steps record the business and the end, once', async () => {
  const ws = await createWorkspace('Funnel Plumbing')
  expect(await eventsOf(ws.id)).toEqual(['signup'])
  await act(ws.owner, 'onboarding.setStep', { step: 'business' })
  expect(await eventsOf(ws.id)).toEqual(['signup'])
  await act(ws.owner, 'onboarding.setStep', { step: 'phone' })
  await act(ws.owner, 'onboarding.setStep', { step: 'hours' })
  await act(ws.owner, 'onboarding.setStep', { step: 'done' })
  expect(await eventsOf(ws.id)).toEqual(['business_found', 'onboarding_done', 'signup'])
})

test('skipping from the first step is recorded without the business', async () => {
  const ws = await createWorkspace('Skip Funnel Plumbing')
  await act(ws.owner, 'onboarding.setStep', { step: 'skipped' })
  expect(await eventsOf(ws.id)).toEqual(['onboarding_skipped', 'signup'])
})

test('the web app reports the forwarding code; only owners and admins can, and only that event', async () => {
  const ws = await createWorkspace('Forwarding Funnel Plumbing')
  expect((await act(ws.owner, 'onboarding.recordEvent', { event: 'forwarding_instructions_shown' })).status).toBe(200)
  expect((await act(ws.owner, 'onboarding.recordEvent', { event: 'forwarding_instructions_shown' })).status).toBe(200)
  expect((await act(ws.owner, 'onboarding.recordEvent', { event: 'activated' })).status).toBe(422)
  const member = await addMember(ws.id, 'member')
  expect((await act(member, 'onboarding.recordEvent', { event: 'forwarding_instructions_shown' })).status).toBe(403)
  expect(await eventsOf(ws.id)).toEqual(['forwarding_instructions_shown', 'signup'])
})

test('a number to put calls through to is the mobile; a test call means the assistant was heard', async () => {
  const ws = await createWorkspace('Mobile Funnel Plumbing')
  await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [] })
  expect(await eventsOf(ws.id)).toEqual(['signup'])
  expect(
    (
      await act(ws.owner, 'assistant.update', {
        assistantId: ws.assistant.id,
        transfers: [transferContact(randomNumber())],
      })
    ).status,
  ).toBe(200)
  const callId = (await act(agent(ws.id), 'call.startTest', { room: `funnel-${ws.id}` })).body.data.callId as string
  await act(agent(ws.id), 'call.finish', { callId })
  expect(await eventsOf(ws.id)).toEqual(['assistant_heard', 'mobile_added', 'signup'])
})

test("calls from the owner's own phone are not real calls; a real caller is, and a handled one activates", async () => {
  const ws = await createWorkspace('Real Call Funnel Plumbing')
  const mobile = randomNumber()
  await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [transferContact(mobile)] })
  const own = await phoneCall(ws.id, ws.number, mobile, 'message')
  expect((await getCall(own))?.from_own_number).toBe(true)
  expect(await eventsOf(ws.id)).toEqual(['mobile_added', 'signup'])
  const real = await phoneCall(ws.id, ws.number, randomNumber(), 'hangup')
  expect((await getCall(real))?.from_own_number).toBe(false)
  expect(await eventsOf(ws.id)).toEqual(['first_real_call', 'mobile_added', 'signup'])
  await phoneCall(ws.id, ws.number, randomNumber(), 'message')
  expect(await eventsOf(ws.id)).toEqual(['activated', 'first_real_call', 'mobile_added', 'signup'])
})

test("a call from another of the business's Linedesk numbers, or from a blocked caller, is no real call", async () => {
  const ws = await createWorkspace('Excluded Calls Funnel Plumbing')
  const second = randomNumber()
  await db
    .insert(phone_numbers)
    .values({ id: `pn_${crypto.randomUUID()}`, workspace_id: ws.id, e164: second, provider: 'dev' })
  const own = await phoneCall(ws.id, ws.number, second, 'message')
  expect((await getCall(own))?.from_own_number).toBe(true)
  expect((await act(ws.owner, 'contact.block', { contactId: ws.contact.id })).status).toBe(200)
  const blocked = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(blocked.body.data.blocked).toBe(true)
  expect(await eventsOf(ws.id)).toEqual(['signup'])
})
