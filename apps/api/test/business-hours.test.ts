// Business hours: owners and admins set the weekly hours in Settings › Assistant; the voice agent gets
// them with every call (call.start, call.startTest) as context: open now or not, and when that changes.
import { workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '07:00', end: '18:00' }))

describe('business hours', () => {
  test('owners set them, members read them, another workspace is untouched', async () => {
    const ws = await createWorkspace('Hours Plumbing')
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.businessHours).toEqual([])
    expect(
      (await act(ws.owner, 'businessHours.set', { hours: [...weekdays, { weekday: 6, start: '08:00', end: '12:00' }] }))
        .status,
    ).toBe(200)
    const member = await addMember(ws.id, 'member')
    const read = (await act(member, 'workspace.getSettings', {})).body.data
    expect(read.businessHours).toHaveLength(6)
    expect(read.businessHours[0]).toEqual({ weekday: 1, start: '07:00', end: '18:00' })
    expect((await act(member, 'businessHours.set', { hours: [] })).status).toBe(403)

    // Saved as a whole: a new list replaces the old one, an empty one clears it.
    await act(ws.owner, 'businessHours.set', { hours: [{ weekday: 2, start: '09:00', end: '17:00' }] })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.businessHours).toEqual([
      { weekday: 2, start: '09:00', end: '17:00' },
    ])
    const other = await createWorkspace('Other Hours Plumbing')
    expect((await act(other.owner, 'workspace.getSettings', {})).body.data.businessHours).toEqual([])
    await act(ws.owner, 'businessHours.set', { hours: [] })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.businessHours).toEqual([])
  })

  test('times must make sense', async () => {
    const ws = await createWorkspace('Bad Hours Plumbing')
    expect(
      (await act(ws.owner, 'businessHours.set', { hours: [{ weekday: 1, start: '18:00', end: '07:00' }] })).status,
    ).toBe(422)
    expect(
      (await act(ws.owner, 'businessHours.set', { hours: [{ weekday: 7, start: '07:00', end: '18:00' }] })).status,
    ).toBe(422)
    expect(
      (await act(ws.owner, 'businessHours.set', { hours: [{ weekday: 1, start: '7am', end: '18:00' }] })).status,
    ).toBe(422)
    expect(
      (await act(ws.owner, 'businessHours.set', { hours: [{ weekday: 0, start: '00:00', end: '24:00' }] })).status,
    ).toBe(200)
  })

  test('the agent gets them with each call; without hours it gets null', async () => {
    const ws = await createWorkspace('Agent Hours Plumbing')
    const first = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
    expect(first.body.data.businessHours).toBeNull()

    await db
      .update(workspace_settings)
      .set({ timezone: 'America/Los_Angeles' })
      .where(eq(workspace_settings.workspace_id, ws.id))
    await act(ws.owner, 'businessHours.set', { hours: weekdays })
    const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
    expect(body.data.businessHours).toMatchObject({
      timeZone: 'America/Los_Angeles',
      weekly: weekdays,
      openNow: expect.any(Boolean),
      summary: expect.stringMatching(
        /^Business hours: Monday to Friday 7:00 AM–6:00 PM \(America\/Los_Angeles\)\. (Open now|Closed now)/,
      ),
    })
  })
})
