import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { applyLocally, type LocalTables } from './index.ts'
import {
  assistantUpdate,
  CONTACT_IMPORT_MAX_ROWS,
  contactBlock,
  contactImport,
  contactMerge,
  contactUnblock,
  workspaceGetSettings,
  workspaceUpdateSettings,
  confirmsNumber,
  phoneNumberRelease,
} from './settings.ts'

describe('assistant.update', () => {
  it('keeps the free-text instructions the voice agent reads', () => {
    const input = assistantUpdate.input.parse({ assistantId: 'as1', business_profile: { instructions: 'Hours: 24/7' } })
    expect(input.business_profile).toEqual({ instructions: 'Hours: 24/7' })
  })

  it('takes a keypad menu (keys 1–9, each once) or null to turn it off', () => {
    const ok = { options: [{ key: '1', label: 'emergencies', action: 'transfer' }, { key: '2', label: 'billing', action: 'topic' }] }
    expect(assistantUpdate.input.safeParse({ assistantId: 'as1', keypad_menu: ok }).success).toBe(true)
    expect(assistantUpdate.input.safeParse({ assistantId: 'as1', keypad_menu: null }).success).toBe(true)
    const bad = (options: unknown[]) => assistantUpdate.input.safeParse({ assistantId: 'as1', keypad_menu: { options } }).success
    expect(bad([])).toBe(false)
    expect(bad([{ key: '0', label: 'x', action: 'topic' }])).toBe(false)
    expect(bad([{ key: '#', label: 'x', action: 'topic' }])).toBe(false)
    expect(bad([{ key: '1', label: ' ', action: 'topic' }])).toBe(false)
    expect(bad([{ key: '1', label: 'a', action: 'topic' }, { key: '1', label: 'b', action: 'topic' }])).toBe(false)
    expect(bad([{ key: '1', label: 'a', action: 'hang-up' }])).toBe(false)
  })

  it('applies the keypad menu locally like any other field', () => {
    const menu = { options: [{ key: '1', label: 'emergencies', action: 'transfer' as const }] }
    const assistants = new Map([['as1', { id: 'as1', keypad_menu: null }]])
    applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, { assistantId: 'as1', keypad_menu: menu }, '2026-11-11T00:00:00Z')
    expect(assistants.get('as1')!.keypad_menu).toEqual(menu)
  })
})

describe('contact.block and contact.unblock', () => {
  it('set and clear blocked_at locally, and need contact:write, which members have', () => {
    const local = { contacts: new Map([['ct1', { id: 'ct1', blocked_at: null }]]) } as unknown as LocalTables
    applyLocally(local, contactBlock, { contactId: 'ct1' }, '2026-11-10T12:00:00.000Z')
    expect((local.contacts.get('ct1') as Contact).blocked_at).toBe('2026-11-10T12:00:00.000Z')
    applyLocally(local, contactUnblock, { contactId: 'ct1' }, '2026-11-10T12:01:00.000Z')
    expect((local.contacts.get('ct1') as Contact).blocked_at).toBeNull()
    for (const def of [contactBlock, contactUnblock]) expect(def.permission).toBe('contact:write')
    expect(rolePermissions.member).toContain('contact:write')
  })
})

describe('workspace.updateSettings', () => {
  it('takes one of the offered retention periods, 0 to keep none, or null to keep recordings', () => {
    for (const days of [0, 30, 60, 90, 180, 365, null])
      expect(workspaceUpdateSettings.input.safeParse({ recordingRetentionDays: days }).success).toBe(true)
    for (const days of [7, 91, -1, '90'])
      expect(workspaceUpdateSettings.input.safeParse({ recordingRetentionDays: days }).success).toBe(false)
  })

  it('takes a real IANA time zone', () => {
    for (const timeZone of ['America/Los_Angeles', 'Europe/Berlin', 'Pacific/Honolulu'])
      expect(workspaceUpdateSettings.input.safeParse({ timeZone }).success).toBe(true)
    for (const timeZone of ['Pacific Time', 'America/Nowhere', ''])
      expect(workspaceUpdateSettings.input.safeParse({ timeZone }).success).toBe(false)
  })

  it('only owners and admins change it; every member reads it', () => {
    expect(rolePermissions.member).not.toContain(workspaceUpdateSettings.permission)
    expect(rolePermissions.admin).toContain(workspaceUpdateSettings.permission)
    for (const role of ['owner', 'admin', 'member'] as const)
      expect(rolePermissions[role]).toContain(workspaceGetSettings.permission)
  })
})

describe('phoneNumber.release', () => {
  it('is for owners and admins, and the typed number is compared by its digits', () => {
    expect(rolePermissions.member).not.toContain(phoneNumberRelease.permission)
    expect(rolePermissions.owner).toContain(phoneNumberRelease.permission)
    for (const typed of ['+15035550142', '(503) 555-0142', '503.555.0142', '1 503 555 0142', '+1 503 555 0142'])
      expect(confirmsNumber(typed, '+15035550142')).toBe(true)
    for (const typed of ['503 555 0143', '555 0142', '', 'yes'])
      expect(confirmsNumber(typed, '+15035550142')).toBe(false)
  })
})

describe('contact.merge', () => {
  it('is for anyone who edits contacts, runs on the server only, and takes the picked details', () => {
    expect(contactMerge.permission).toBe('contact:write')
    expect(rolePermissions.member).toContain('contact:write')
    expect(contactMerge.patch).toBeUndefined()
    expect(contactMerge.input.parse({ keepId: 'a', mergeId: 'b', name: ' Sam ', email: null })).toEqual({ keepId: 'a', mergeId: 'b', name: 'Sam', email: null })
  })
})

describe('contact.import', () => {
  it('is for anyone who edits contacts, takes E.164 numbers and at most CONTACT_IMPORT_MAX_ROWS rows', () => {
    expect(contactImport.permission).toBe('contact:write')
    expect(contactImport.input.safeParse({ rows: [{ phone: '+15035550142', name: ' Sam ' }] }).data).toEqual({ rows: [{ phone: '+15035550142', name: 'Sam' }] })
    expect(contactImport.input.safeParse({ rows: [{ phone: '5035550142' }] }).success).toBe(false)
    expect(contactImport.input.safeParse({ rows: [] }).success).toBe(false)
    expect(contactImport.input.safeParse({ rows: Array(CONTACT_IMPORT_MAX_ROWS + 1).fill({ phone: '+15035550142' }) }).success).toBe(false)
  })
})
