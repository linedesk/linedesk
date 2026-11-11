// A call's details: custom fields (owners and admins, capped), the lead and tag from call.finish and
// edits, custom values checked against their field, the CSV export and the webhook payload.
import { MAX_CUSTOM_FIELDS } from '@linedesk/actions'
import { custom_fields } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { callsCsv, csvCell } from '../src/call-details.ts'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, getCall, randomNumber, type User, type Workspace } from './helpers.ts'

let ws: Workspace
let member: User

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  member = await addMember(ws.id, 'member')
})

async function addField(input: Record<string, unknown>) {
  const res = await act(ws.owner, 'customField.upsert', input)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data.fieldId as string
}

async function finishedCall(finish: Record<string, unknown> = {}) {
  const started = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  const callId = started.body.data.callId as string
  const res = await act(agent(ws.id), 'call.finish', { callId, outcome: 'message', title: 'Leak', summary: 'A leak.', ...finish })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { callId, start: started.body.data }
}

describe('custom fields', () => {
  test('owners add them, members cannot; a choice needs two options; the cap holds', async () => {
    expect((await act(member, 'customField.upsert', { label: 'Size', type: 'text' })).status).toBe(403)
    expect((await act(ws.owner, 'customField.upsert', { label: 'Size', type: 'choice', options: ['One'] })).status).toBe(409)
    const id = await addField({ label: 'Home size', type: 'choice', options: ['Small', 'Large'], askCaller: true })
    expect((await act(ws.owner, 'customField.upsert', { label: 'home size', type: 'text' })).status).toBe(409)
    const [row] = await db.select().from(custom_fields).where(eq(custom_fields.id, id))
    expect(row).toMatchObject({ workspace_id: ws.id, ask_caller: true, options: ['Small', 'Large'] })

    const other = await createWorkspace('Other')
    for (let i = 0; i < MAX_CUSTOM_FIELDS; i++) expect((await act(other.owner, 'customField.upsert', { label: `F${i}`, type: 'text' })).status).toBe(200)
    expect((await act(other.owner, 'customField.upsert', { label: 'One more', type: 'text' })).status).toBe(409)
    // Another workspace's field cannot be changed.
    expect((await act(other.owner, 'customField.upsert', { fieldId: id, label: 'Taken', type: 'text' })).status).toBe(409)
  })

  test('call.start gives the agent the fields; call.finish keeps values that fit and drops the rest', async () => {
    const pets = await addField({ label: 'Pets', type: 'boolean' })
    const { callId, start } = await finishedCall({ customValues: { [pets]: 'yes', cf_unknown: 'x' } })
    expect(start.customFields.map((f: { label: string }) => f.label)).toEqual(expect.arrayContaining(['Home size', 'Pets']))
    expect((await getCall(callId))!.custom_values).toEqual({ [pets]: true })
  })

  test('call.setCustomValues merges, clears with null and refuses a value that does not fit', async () => {
    const budget = await addField({ label: 'Budget', type: 'number' })
    const note = await addField({ label: 'Gate code', type: 'text' })
    const { callId } = await finishedCall()
    expect((await act(member, 'call.setCustomValues', { callId, values: { [budget]: '1,200' } })).status).toBe(200)
    expect((await act(member, 'call.setCustomValues', { callId, values: { [note]: '4411' } })).status).toBe(200)
    expect((await getCall(callId))!.custom_values).toEqual({ [budget]: 1200, [note]: '4411' })
    expect((await act(member, 'call.setCustomValues', { callId, values: { [budget]: 'lots' } })).status).toBe(409)
    expect((await act(member, 'call.setCustomValues', { callId, values: { [note]: null } })).status).toBe(200)
    expect((await getCall(callId))!.custom_values).toEqual({ [budget]: 1200 })
  })
})

describe('lead and tag', () => {
  test('call.finish stores the lead and tag; the callback number defaults to the caller ID; edits survive a repeated finish', async () => {
    const { callId } = await finishedCall({ lead: { callerName: 'Sarah Whitfield', address: '3127 SE Division St', jobType: 'Burst pipe' }, tag: 'new_lead' })
    const call = (await getCall(callId))!
    expect(call).toMatchObject({ caller_name: 'Sarah Whitfield', address: '3127 SE Division St', job_type: 'Burst pipe', tag: 'new_lead', callback_number: call.from_number })

    expect((await act(member, 'call.updateLead', { callId, jobType: 'Pipe repair', callbackNumber: '+15035550199', urgency: 'urgent' })).status).toBe(200)
    expect((await act(member, 'call.setTag', { callId, tag: 'existing_customer' })).status).toBe(200)
    await act(agent(ws.id), 'call.finish', { callId, lead: { jobType: 'Leak' }, tag: 'message' })
    expect(await getCall(callId)).toMatchObject({ job_type: 'Pipe repair', callback_number: '+15035550199', urgency: 'urgent', tag: 'existing_customer' })
    expect((await act(member, 'call.setTag', { callId, tag: 'vip' })).status).toBe(422)
  })
})

describe('export', () => {
  test('owners and admins export a date range as CSV; members cannot', async () => {
    const { callId } = await finishedCall({ lead: { callerName: '=HYPERLINK("x")' }, tag: 'booked' })
    const today = new Date().toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    expect((await act(member, 'call.export', { from: today, to: tomorrow })).status).toBe(403)
    const res = await act(ws.owner, 'call.export', { from: today, to: tomorrow })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.csv).toContain(callId)
    expect(res.body.data.csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(res.body.data.csv.split('\r\n')[0]).toContain('Home size')
    expect((await act(ws.owner, 'call.export', { from: tomorrow, to: today })).status).toBe(422)
  })

  test('cells: phone numbers stay, formulas do not run, quotes and commas are escaped', () => {
    expect(csvCell('+15035550117')).toBe('+15035550117')
    expect(csvCell('-12')).toBe('-12')
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('a, "b"')).toBe('"a, ""b"""')
    expect(callsCsv([], [], 'America/Los_Angeles').startsWith('﻿Started,')).toBe(true)
  })
})
