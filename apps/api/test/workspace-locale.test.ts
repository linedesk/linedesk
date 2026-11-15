// The workspace's country and language (workspace_settings.country, .language): set in Workspace settings › General,
// else worked out when read. A US workspace reads US and English as before; call.start brings both to the agent.
import { phone_numbers } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, agent, createWorkspace, randomNumber } from './helpers.ts'

describe('workspace country and language', () => {
  test('a US workspace: automatic, US and English, USD; call.start brings them', async () => {
    const ws = await createWorkspace('Locale US Plumbing')
    const data = (await act(ws.owner, 'workspace.getSettings', {})).body.data
    expect(data).toMatchObject({
      country: null,
      language: null,
      resolvedCountry: 'US',
      countrySource: 'assistant_number',
      resolvedLanguage: 'en',
      jobValueCurrency: 'USD',
    })
    const call = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
    expect(call).toMatchObject({ workspaceCountry: 'US', workspaceLanguage: 'en' })
  })

  test('worked out from a Mexican number; set by the owner; back to automatic with null', async () => {
    const ws = await createWorkspace('Locale MX Plomería')
    await db
      .update(phone_numbers)
      .set({ e164: '+5255' + String(Date.now()).slice(-8) })
      .where(eq(phone_numbers.e164, ws.number))
    const auto = (await act(ws.owner, 'workspace.getSettings', {})).body.data
    expect(auto).toMatchObject({
      resolvedCountry: 'MX',
      resolvedLanguage: 'es',
      jobValueCurrency: 'MXN',
      country: null,
    })

    const set = await act(ws.owner, 'workspace.updateSettings', { country: 'kr', language: 'ja' })
    expect(set.status).toBe(200)
    expect(set.body.data).toMatchObject({
      country: 'KR',
      language: 'ja',
      resolvedCountry: 'KR',
      countrySource: 'explicit',
      resolvedLanguage: 'ja',
    })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({ jobValueCurrency: 'KRW' })

    await act(ws.owner, 'workspace.updateSettings', { country: null, language: null })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      country: null,
      language: null,
      resolvedCountry: 'MX',
    })
  })

  test('a saved appointment value keeps its currency', async () => {
    const ws = await createWorkspace('Locale Value Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { jobValueCents: 35000, jobValueCurrency: 'USD' })
    await act(ws.owner, 'workspace.updateSettings', { country: 'GB' })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      jobValueCents: 35000,
      jobValueCurrency: 'USD',
    })
  })

  test('only owners and admins change it; unknown countries and unsupported languages are refused', async () => {
    const ws = await createWorkspace('Locale Rules Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.updateSettings', { country: 'GB' })).status).toBe(403)
    expect((await act(ws.owner, 'workspace.updateSettings', { country: 'XX' })).status).toBe(422)
    expect((await act(ws.owner, 'workspace.updateSettings', { language: 'ko' })).status).toBe(422)
    expect((await act(member, 'workspace.getSettings', {})).body.data.country).toBeNull()
  })

  test('the holiday lookup opens with the workspace country', async () => {
    const ws = await createWorkspace('Locale Holidays Plumbing')
    await act(ws.owner, 'workspace.updateSettings', { country: 'GB' })
    expect((await act(ws.owner, 'holidays.lookup', {})).body.data.country).toBe('GB')
  })
})
