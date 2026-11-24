import { calls, contacts, transcript_segments } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { firstUse, renamed, sampleHandlers } from '../src/sample-calls.ts'
import { act, addMember, createWorkspace } from './helpers.ts'

const countOf = async (workspaceId: string) => ({
  calls: (
    await db
      .select()
      .from(calls)
      .where(and(eq(calls.workspace_id, workspaceId), eq(calls.source, 'sample')))
  ).length,
  contacts: (await db.select().from(contacts).where(eq(contacts.workspace_id, workspaceId))).length,
  segments: (await db.select().from(transcript_segments).where(eq(transcript_segments.workspace_id, workspaceId)))
    .length,
})

describe('sample calls', () => {
  test('added once, marked as samples, in the business and assistant names of the workspace', async () => {
    const ws = await createWorkspace('Riverside Electric')
    const { status, body } = await act(ws.owner, 'sample.add', {})
    expect(status).toBe(200)
    expect(body.rows.calls.length).toBeGreaterThan(5)
    expect(body.rows.calls.every((c: { source: string }) => c.source === 'sample')).toBe(true)
    expect(body.rows.contacts.every((c: { id: string }) => c.id.startsWith('smp_'))).toBe(true)
    const words = JSON.stringify(body.rows.transcript_segments)
    expect(words).toContain('Riverside Electric')
    expect(words).not.toContain('Brightwater')
    // They fit any trade: no plumbing, no demo owner's name.
    for (const word of ['Mike', 'pipe', 'water heater', 'disposal', 'toilet']) expect(words).not.toContain(word)
    const once = await countOf(ws.id)
    expect((await act(ws.owner, 'sample.add', {})).body.rows).toEqual({})
    expect(await countOf(ws.id)).toEqual(once)
  })

  test("in the language of the person who adds them, with the workspace's names in the greeting", async () => {
    const ws = await createWorkspace('Lindenhof Elektro')
    // The pseudo-language marks every catalog sentence ⟦…⟧: text without it was not written in the reader's language.
    const actor = { workspaceId: ws.id, locale: 'en-XA' }
    const { rows } = await db.transaction(tx => sampleHandlers['sample.add']!({ tx, actor } as never, {}))
    const added = rows as {
      calls: { title: string; summary: string }[]
      transcript_segments: { text: string }[]
      contacts: { name: string | null }[]
    }
    for (const text of [
      ...added.calls.flatMap(c => [c.title, c.summary]),
      ...added.transcript_segments.map(s => s.text),
      ...added.contacts.flatMap(c => (c.name ? [c.name] : [])),
    ])
      expect(text).toMatch(/^⟦.*⟧$/s)
    expect(added.transcript_segments[0]!.text).toContain('Lindenhof Elektro')
  })

  test('removed in one go: calls, transcripts and sample callers; other workspaces keep theirs', async () => {
    const ws = await createWorkspace('Remove Plumbing')
    const other = await createWorkspace('Other Plumbing')
    const empty = await countOf(ws.id)
    await act(ws.owner, 'sample.add', {})
    await act(other.owner, 'sample.add', {})
    const before = await countOf(other.id)
    const { status, body } = await act(ws.owner, 'sample.remove', {})
    expect(status).toBe(200)
    expect(body.deleted.calls.length).toBe(body.data.removed)
    expect(body.deleted.transcript_segments.length).toBeGreaterThan(0)
    expect(await countOf(ws.id)).toEqual(empty)
    expect(await countOf(other.id)).toEqual(before)
    expect((await act(ws.owner, 'sample.remove', {})).body.rows).toEqual({})
  })

  test('only owners and admins add or remove them', async () => {
    const ws = await createWorkspace('Member Sample Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'sample.add', {})).status).toBe(403)
    expect((await act(member, 'sample.remove', {})).status).toBe(403)
  })

  test('FIRST_USE picks the variant; both when unset or unknown', () => {
    expect(firstUse({})).toBe('both')
    expect(firstUse({ FIRST_USE: ' Tour ' })).toBe('tour')
    expect(firstUse({ FIRST_USE: 'sample' })).toBe('sample')
    expect(firstUse({ FIRST_USE: 'off' })).toBe('off')
    expect(firstUse({ FIRST_USE: 'wizard' })).toBe('both')
    expect(renamed('Brightwater Plumbing & Heating. This is Maya.', 'Riverside Electric', 'Ava')).toBe(
      'Riverside Electric. This is Ava.',
    )
  })
})
