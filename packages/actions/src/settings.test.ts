import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { storedSnapshot } from './assistant-versions.ts'
import { applyLocally, type LocalTables } from './index.ts'
import {
  assistantUpdate,
  CONTACT_IMPORT_MAX_ROWS,
  CONTACT_IMPORT_LIMITS,
  contactBlock,
  contactCreate,
  contactImport,
  contactMerge,
  contactUnblock,
  workspaceName,
  workspaceNameProblem,
  businessPhoneProblem,
  businessWebsiteProblem,
  workspaceGetSettings,
  workspaceUpdateSettings,
  confirmsNumber,
  phoneNumberRelease,
  pipelineFor,
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

  it('sets how calls are answered, and back to the install default with null', () => {
    const assistants = new Map([['as1', { id: 'as1', voice_pipeline: null }]])
    const update = (fields: object) =>
      applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, assistantUpdate.input.parse({ assistantId: 'as1', ...fields }), '2026-11-13T00:00:00Z')
    update({ voice_pipeline: 'three_stage' })
    expect(assistants.get('as1')).toMatchObject({ voice_pipeline: 'three_stage' })
    update({ name: 'Maya' }) // another field leaves it alone
    expect(assistants.get('as1')).toMatchObject({ voice_pipeline: 'three_stage' })
    update({ voice_pipeline: null })
    expect(assistants.get('as1')).toMatchObject({ voice_pipeline: null })
    expect(() => assistantUpdate.input.parse({ assistantId: 'as1', voice_pipeline: 'cascaded' })).toThrow()
  })

  it('takes settings:write: owners and admins choose the pipeline, members do not', () => {
    expect(assistantUpdate.permission).toBe('settings:write')
    expect(rolePermissions.owner).toContain('settings:write')
    expect(rolePermissions.member).not.toContain('settings:write')
  })
})

describe('pipelineFor', () => {
  const both = { realtime: true, three_stage: true }
  it("uses the assistant's choice when it is set up", () => {
    expect(pipelineFor('three_stage', both)).toBe('three_stage')
    expect(pipelineFor('realtime', both)).toBe('realtime')
  })
  it('without a choice: the realtime model when set up, else the three stages', () => {
    expect(pipelineFor(null, both)).toBe('realtime')
    expect(pipelineFor(undefined, { realtime: false, three_stage: true })).toBe('three_stage')
  })
  it('falls back to the other one when the chosen one is not set up', () => {
    expect(pipelineFor('realtime', { realtime: false, three_stage: true })).toBe('three_stage')
    expect(pipelineFor('three_stage', { realtime: true, three_stage: false })).toBe('realtime')
  })
  it('keeps the choice when neither is set up', () => {
    expect(pipelineFor('three_stage', { realtime: false, three_stage: false })).toBe('three_stage')
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

describe('contact.create', () => {
  it('takes every detail a contact has, trimmed, and needs contact:write like contact.update', () => {
    expect(contactCreate.permission).toBe('contact:write')
    expect(rolePermissions.member).toContain('contact:write')
    expect(
      contactCreate.input.parse({
        phone: '+15035550142',
        name: ' Dana Ortiz ',
        company: 'Ortiz Bakery',
        email: ' dana@ortiz.example ',
        address: '12 Oak St',
        note: 'Gate code 4411',
      }),
    ).toEqual({
      phone: '+15035550142',
      name: 'Dana Ortiz',
      company: 'Ortiz Bakery',
      email: 'dana@ortiz.example',
      address: '12 Oak St',
      note: 'Gate code 4411',
    })
  })

  it('refuses a number not in E.164, blank details and details longer than a contact keeps', () => {
    expect(contactCreate.input.safeParse({ phone: '503 555 0142' }).success).toBe(false)
    expect(contactCreate.input.safeParse({ phone: '+15035550142', email: '   ' }).success).toBe(false)
    for (const field of ['name', 'company', 'email', 'address', 'note'] as const) {
      const max = CONTACT_IMPORT_LIMITS[field]
      expect(contactCreate.input.safeParse({ phone: '+15035550142', [field]: 'x'.repeat(max) }).success).toBe(true)
      expect(
        contactCreate.input.safeParse({ phone: '+15035550142', [field]: 'x'.repeat(max + 1) }).success,
        field,
      ).toBe(false)
    }
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

describe('workspaceName', () => {
  it('one line of 1 to 80 characters, trimmed, without control or bidi characters', () => {
    expect(workspaceName.parse('  Brightwater Plumbing & Heating  ')).toBe('Brightwater Plumbing & Heating')
    expect(workspaceName.parse('Café Dentistry, Portland')).toBe('Café Dentistry, Portland')
    expect(workspaceNameProblem('x'.repeat(80))).toBeNull()
    const bad = ['', '   ', 'x'.repeat(81), 'Two\nlines', 'Nul\u0000', 'C1\u0085', 'Rtl \u202Egnirts', 'Isolate \u2067x', 'Mark\u200F', 42]
    for (const name of bad) expect(workspaceNameProblem(name), JSON.stringify(name)).not.toBeNull()
  })
})

describe('the business phone and website in the profile', () => {
  it('a phone as people and listings write it, a website address; empty is fine', () => {
    for (const ok of ['', '(503) 555-0142', '+1 503-555-0142', '503.555.0142', '+15035550142'])
      expect(businessPhoneProblem(ok), ok).toBeNull()
    for (const bad of ['abc', '555', '+1 503 555 0142 call me', '1234567890123456'])
      expect(businessPhoneProblem(bad), bad).not.toBeNull()
    for (const ok of ['', 'yourbusiness.com', 'https://www.yourbusiness.com/', 'http://a.co/contact?x=1'])
      expect(businessWebsiteProblem(ok), ok).toBeNull()
    for (const bad of ['not a url', 'yourbusiness', 'ftp://x.com', 'https://'])
      expect(businessWebsiteProblem(bad), bad).not.toBeNull()
  })
})
