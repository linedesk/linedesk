import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { storedSnapshot } from './assistant-versions.ts'
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
  talkingSpeedLabel,
  talkingSpeedPctOf,
} from './settings.ts'

describe('assistant.update', () => {
  it('keeps the free-text instructions the voice agent reads', () => {
    const input = assistantUpdate.input.parse({ assistantId: 'as1', business_profile: { instructions: 'Hours: 24/7' } })
    expect(input.business_profile).toEqual({ instructions: 'Hours: 24/7' })
  })

  it('accepts a keypad menu from an older web app and drops it (the feature is gone)', () => {
    const old = { assistantId: 'as1', name: 'Maya', keypad_menu: { options: [{ key: '1', label: 'emergencies', action: 'transfer' }] } }
    const input = assistantUpdate.input.parse(old)
    expect(input).not.toHaveProperty('keypad_menu')
    const assistants = new Map([['as1', { id: 'as1', name: 'Max' }]])
    applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, input, '2026-11-11T00:00:00Z') // the server applies the parsed input
    expect(assistants.get('as1')).toEqual({ id: 'as1', name: 'Maya' })
  })

  it('takes any talking speed from 80 to 120 percent and keeps the old three speeds in step', () => {
    const assistants = new Map([['as1', { id: 'as1' }]])
    const update = (fields: object) =>
      applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, assistantUpdate.input.parse({ assistantId: 'as1', ...fields }), '2026-11-12T00:00:00Z')
    update({ talking_speed_pct: 93 })
    expect(assistants.get('as1')).toMatchObject({ talking_speed_pct: 93, talking_speed: 'slow' })
    update({ talking_speed_pct: 103 })
    expect(assistants.get('as1')).toMatchObject({ talking_speed_pct: 103, talking_speed: 'normal' })
    // A web app of the release before sends only the old speed.
    update({ talking_speed: 'fast' })
    expect(assistants.get('as1')).toMatchObject({ talking_speed_pct: 110, talking_speed: 'fast' })
    for (const pct of [79, 121, 100.5]) expect(() => assistantUpdate.input.parse({ assistantId: 'as1', talking_speed_pct: pct })).toThrow()
  })

  it('says the talking speed in a few words', () => {
    expect([90, 100, 115].map(talkingSpeedLabel)).toEqual(['10% slower', 'Normal', '15% faster'])
    expect(talkingSpeedPctOf({ talking_speed: 'slow' })).toBe(90)
    expect(talkingSpeedPctOf(null)).toBe(100)
  })

  it('restores the speed of a version saved before percentages', () => {
    expect(storedSnapshot({ talking_speed: 'fast' })).toMatchObject({ talking_speed: 'fast', talking_speed_pct: 110 })
    expect(storedSnapshot({ talking_speed: 'slow', talking_speed_pct: 85 })).toMatchObject({ talking_speed_pct: 85 })
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
