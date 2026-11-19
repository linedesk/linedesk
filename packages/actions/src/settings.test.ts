import type { Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { rolePermissions } from './define.ts'
import { storedSnapshot } from './assistant-versions.ts'
import { EMAIL_ALWAYS_MAX, EMAIL_RULE_TO_MAX, EMAIL_RULE_WHEN_MAX, EMAIL_RULES_MAX } from './email-routing.ts'
import { applyLocally, type LocalTables } from './index.ts'
import { english, type Words } from './words.ts'
import { currencyDigits, fromMinorUnits, jobValueCurrencies, rescaleMinorUnits, toMinorUnits } from './insights.ts'
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
import {
  isRealtimeVoice,
  REALTIME_DEFAULT_VOICE,
  REALTIME_VOICE_IDS,
  RECOMMENDED_REALTIME_VOICES,
  realtimeVoiceFor,
  realtimeVoices,
} from './voices.ts'

describe('assistant.update', () => {
  it('takes call email rules: normalized, within the limits, owners and admins only (LIN-470)', () => {
    const rule = (over: object = {}) => ({
      id: 'r1',
      when: ' Calls about water heaters or boilers ',
      to: ['u1', 'u2', 'u1'],
      assign: 'u2',
      ...over,
    })
    const parse = (email_rules: unknown) => assistantUpdate.input.parse({ assistantId: 'as1', email_rules }).email_rules
    expect(parse({ always: ['u3', 'u3'], rules: [rule()] })).toEqual({
      always: ['u3'],
      rules: [
        {
          id: 'r1',
          when: 'Calls about water heaters or boilers',
          to: ['u1', 'u2'],
          assign: 'u2',
        },
      ],
    })
    // An assignee who is not one of the rule's members is dropped, not refused.
    expect(parse({ always: [], rules: [rule({ assign: 'u9' })] })!.rules[0]!.assign).toBeNull()
    const assistants = new Map([['as1', { id: 'as1', email_rules: { always: [], rules: [] } }]])
    applyLocally(
      { assistants } as unknown as LocalTables,
      assistantUpdate,
      assistantUpdate.input.parse({ assistantId: 'as1', email_rules: { always: ['u3'], rules: [rule()] } }),
      '2026-11-17T00:00:00Z',
    )
    expect(assistants.get('as1')).toMatchObject({
      email_rules: {
        always: ['u3'],
        rules: [{ when: 'Calls about water heaters or boilers', to: ['u1', 'u2'], assign: 'u2' }],
      },
    })
    // Limits: `when` (not blank, at most EMAIL_RULE_WHEN_MAX), members per rule, always and the number of rules.
    for (const bad of [
      { always: [], rules: [rule({ when: '   ' })] },
      { always: [], rules: [rule({ when: 'x'.repeat(EMAIL_RULE_WHEN_MAX + 1) })] },
      {
        always: [],
        rules: [rule({ to: Array.from({ length: EMAIL_RULE_TO_MAX + 1 }, (_, i) => `u${i}`), assign: null })],
      },
      { always: Array.from({ length: EMAIL_ALWAYS_MAX + 1 }, (_, i) => `u${i}`), rules: [] },
      { always: [], rules: Array.from({ length: EMAIL_RULES_MAX + 1 }, (_, i) => rule({ id: `r${i}` })) },
      { rules: [] },
    ])
      expect(() => parse(bad)).toThrow()
    expect(assistantUpdate.permission).toBe('settings:write')
    expect(rolePermissions.member).not.toContain('settings:write')
  })

  it('keeps the free-text instructions the voice agent reads', () => {
    const input = assistantUpdate.input.parse({ assistantId: 'as1', business_profile: { instructions: 'Hours: 24/7' } })
    expect(input.business_profile).toEqual({ instructions: 'Hours: 24/7' })
  })

  it('accepts a keypad menu from an older web app and drops it (the feature is gone)', () => {
    const old = {
      assistantId: 'as1',
      name: 'Maya',
      keypad_menu: { options: [{ key: '1', label: 'emergencies', action: 'transfer' }] },
    }
    const input = assistantUpdate.input.parse(old)
    expect(input).not.toHaveProperty('keypad_menu')
    const assistants = new Map([['as1', { id: 'as1', name: 'Max' }]])
    applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, input, '2026-11-11T00:00:00Z') // the server applies the parsed input
    expect(assistants.get('as1')).toEqual({ id: 'as1', name: 'Maya' })
  })

  it('takes any talking speed from 80 to 120 percent and keeps the old three speeds in step', () => {
    const assistants = new Map([['as1', { id: 'as1' }]])
    const update = (fields: object) =>
      applyLocally(
        { assistants } as unknown as LocalTables,
        assistantUpdate,
        assistantUpdate.input.parse({ assistantId: 'as1', ...fields }),
        '2026-11-12T00:00:00Z',
      )
    update({ talking_speed_pct: 93 })
    expect(assistants.get('as1')).toMatchObject({ talking_speed_pct: 93, talking_speed: 'slow' })
    update({ talking_speed_pct: 103 })
    expect(assistants.get('as1')).toMatchObject({ talking_speed_pct: 103, talking_speed: 'normal' })
    // A web app of the release before sends only the old speed.
    update({ talking_speed: 'fast' })
    expect(assistants.get('as1')).toMatchObject({ talking_speed_pct: 110, talking_speed: 'fast' })
    for (const pct of [79, 121, 100.5])
      expect(() => assistantUpdate.input.parse({ assistantId: 'as1', talking_speed_pct: pct })).toThrow()
  })

  it("takes the assistant's realtime voice: one of the realtime model's voices, or '' for the server's default", () => {
    const assistants = new Map([['as1', { id: 'as1', realtime_voice: '' }]])
    const parse = (realtime_voice: unknown) => assistantUpdate.input.parse({ assistantId: 'as1', realtime_voice })
    applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, parse('cedar'), '2026-11-15T00:00:00Z')
    expect(assistants.get('as1')).toMatchObject({ realtime_voice: 'cedar' })
    applyLocally({ assistants } as unknown as LocalTables, assistantUpdate, parse(''), '2026-11-15T00:00:00Z')
    expect(assistants.get('as1')).toMatchObject({ realtime_voice: '' })
    // A three-stage voice id, a TTS-only OpenAI voice and anything else are refused.
    for (const bad of ['cgSgspJ2msm6clMCkdW9', 'nova', 'fable', 'Marin', 42]) expect(() => parse(bad)).toThrow()
  })

  it('a version from before realtime voices restores without touching the realtime voice', () => {
    expect(storedSnapshot({ name: 'Maya', calendars: [] })).not.toHaveProperty('realtime_voice')
    expect(storedSnapshot({ name: 'Maya', realtime_voice: 'ash', calendars: [] })).toMatchObject({
      realtime_voice: 'ash',
    })
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

  it('sets the call quality; voice_pipeline is no input any more', () => {
    const assistants = new Map([['as1', { id: 'as1', call_quality: 'standard', voice_pipeline: null }]])
    const update = (fields: object) =>
      applyLocally(
        { assistants } as unknown as LocalTables,
        assistantUpdate,
        assistantUpdate.input.parse({ assistantId: 'as1', ...fields }),
        '2026-11-13T00:00:00Z',
      )
    update({ call_quality: 'premium' })
    expect(assistants.get('as1')).toMatchObject({ call_quality: 'premium' })
    update({ name: 'Maya' }) // another field leaves it alone
    expect(assistants.get('as1')).toMatchObject({ call_quality: 'premium' })
    update({ voice_pipeline: 'realtime' }) // not an input: dropped
    expect(assistants.get('as1')).toMatchObject({ call_quality: 'premium', voice_pipeline: null })
    expect(() => assistantUpdate.input.parse({ assistantId: 'as1', call_quality: 'gold' })).toThrow()
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

  it('takes the appointment value in any offered currency, and no other', () => {
    for (const jobValueCurrency of [
      'USD',
      'MXN',
      'NZD',
      'JPY',
      'INR',
      'BRL',
      'SGD',
      'ZAR',
      'SEK',
      'NOK',
      'DKK',
      'CNY',
      'KRW',
      'PLN',
      'AED',
      'NGN',
    ])
      expect(workspaceUpdateSettings.input.safeParse({ jobValueCurrency }).success).toBe(true)
    for (const jobValueCurrency of ['usd', 'XYZ', 'RUB', ''])
      expect(workspaceUpdateSettings.input.safeParse({ jobValueCurrency }).success).toBe(false)
    expect(jobValueCurrencies[0]).toBe('USD')
    expect(jobValueCurrencies.slice(1)).toEqual([...jobValueCurrencies.slice(1)].sort())
    expect(jobValueCurrencies).toHaveLength(39)
  })

  it('counts each currency in its minor units, as Intl does: cents, whole yen for JPY', () => {
    // ISO 4217 has 2 minor units for COP, HUF and IDR; ICU 78 (CLDR 48, Node 22.23) formats them without decimals,
    // older ICU with 2. Stored amounts follow ISO, so these three are left out of the comparison with Intl.
    const isoOverIcu = new Set(['COP', 'HUF', 'IDR'])
    for (const currency of jobValueCurrencies.filter(c => !isoOverIcu.has(c)))
      expect(currencyDigits(currency)).toBe(
        new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits,
      )
    expect(currencyDigits('COP')).toBe(2)
    expect(currencyDigits('HUF')).toBe(2)
    expect(currencyDigits('JPY')).toBe(0)
    expect(currencyDigits('KRW')).toBe(0)
    expect(currencyDigits('CLP')).toBe(0)
    expect(currencyDigits('IDR')).toBe(2)
    expect(toMinorUnits(50_000, 'KRW')).toBe(50_000)
    expect(toMinorUnits(350.5, 'USD')).toBe(35_050)
    expect(toMinorUnits(5000, 'JPY')).toBe(5000)
    expect(fromMinorUnits(5000, 'JPY')).toBe(5000)
    // A change of currency alone keeps the amount: $350 → ¥350, ¥5,000 → $5,000, $350.50 → ¥351.
    expect(rescaleMinorUnits(35_000, 'USD', 'JPY')).toBe(350)
    expect(rescaleMinorUnits(5000, 'JPY', 'USD')).toBe(500_000)
    expect(rescaleMinorUnits(35_050, 'USD', 'JPY')).toBe(351)
    expect(rescaleMinorUnits(35_000, 'USD', 'SEK')).toBe(35_000)
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
    expect(contactMerge.input.parse({ keepId: 'a', mergeId: 'b', name: ' Sam ', email: null })).toEqual({
      keepId: 'a',
      mergeId: 'b',
      name: 'Sam',
      email: null,
    })
  })
})

describe('contact.import', () => {
  it('is for anyone who edits contacts, takes E.164 numbers and at most CONTACT_IMPORT_MAX_ROWS rows', () => {
    expect(contactImport.permission).toBe('contact:write')
    expect(contactImport.input.safeParse({ rows: [{ phone: '+15035550142', name: ' Sam ' }] }).data).toEqual({
      rows: [{ phone: '+15035550142', name: 'Sam' }],
    })
    expect(contactImport.input.safeParse({ rows: [{ phone: '5035550142' }] }).success).toBe(false)
    expect(contactImport.input.safeParse({ rows: [] }).success).toBe(false)
    expect(
      contactImport.input.safeParse({ rows: Array(CONTACT_IMPORT_MAX_ROWS + 1).fill({ phone: '+15035550142' }) })
        .success,
    ).toBe(false)
  })
})

describe('workspaceName', () => {
  it('one line of 1 to 80 characters, trimmed, without control or bidi characters', () => {
    expect(workspaceName.parse('  Brightwater Plumbing & Heating  ')).toBe('Brightwater Plumbing & Heating')
    expect(workspaceName.parse('Café Dentistry, Portland')).toBe('Café Dentistry, Portland')
    expect(workspaceNameProblem('x'.repeat(80))).toBeNull()
    const bad = [
      '',
      '   ',
      'x'.repeat(81),
      'Two\nlines',
      'Nul\u0000',
      'C1\u0085',
      'Rtl \u202Egnirts',
      'Isolate \u2067x',
      'Mark\u200F',
      42,
    ]
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
  it("says what is wrong in the reader's words (the web app passes its language, LIN-371)", () => {
    const keys: Words = { ...english, t: (key => key) as Words['t'] }
    expect([
      workspaceNameProblem('', keys),
      workspaceNameProblem('x'.repeat(81), keys),
      workspaceNameProblem('Two\nlines', keys),
      businessPhoneProblem('abc', keys),
      businessWebsiteProblem('not a url', keys),
    ]).toEqual([
      'common.business.problem.nameEmpty',
      'common.business.problem.nameTooLong',
      'common.business.problem.nameOneLine',
      'common.business.problem.phone',
      'common.business.problem.website',
    ])
    expect(workspaceNameProblem('x'.repeat(81))).toBe('The name can be 80 characters at most.')
    // The schema the API checks with says the same, in English.
    expect(workspaceName.safeParse(' ').error?.issues[0]?.message).toBe(workspaceNameProblem(' '))
  })
})

describe('workspace.deleteOwn and workspace.deletePreview', () => {
  it('need workspace:own, which only the owner has (admins and members lack it); the handler checks the owner row too (apps/api/test/workspace-delete-own.test.ts)', async () => {
    const { actions } = await import('./index.ts')
    const { workspaceDeleteOwn, workspaceDeletePreview } = await import('./settings.ts')
    for (const def of [workspaceDeleteOwn, workspaceDeletePreview]) {
      expect(actions.get(def.name)).toBe(def)
      expect(def.permission).toBe('workspace:own')
      expect(rolePermissions.owner).toContain(def.permission)
      expect(rolePermissions.admin).not.toContain(def.permission)
      expect(rolePermissions.member).not.toContain(def.permission)
      expect(rolePermissions.agent).not.toContain(def.permission)
      // Never offered to API keys or MCP.
      expect(def.public).toBeUndefined()
    }
    // `destructive` is for public actions (MCP); this one is not public at all.
    expect(workspaceDeleteOwn.destructive).toBeUndefined()
    expect(workspaceDeleteOwn.patch).toBeUndefined()
    expect(workspaceDeletePreview.readOnly).toBe(true)
  })

  it('takes the typed name and whether the owner keeps their account, nothing else', async () => {
    const { workspaceDeleteOwn } = await import('./settings.ts')
    expect(workspaceDeleteOwn.input.parse({ name: ' Brightwater ' })).toEqual({ name: 'Brightwater' })
    expect(workspaceDeleteOwn.input.parse({ name: 'B', keepOwnAccount: true })).toEqual({
      name: 'B',
      keepOwnAccount: true,
    })
    expect(workspaceDeleteOwn.input.safeParse({ name: '  ' }).success).toBe(false)
    expect(workspaceDeleteOwn.input.safeParse({}).success).toBe(false)
  })

  it('stores its input as it came: no field is secret, so nothing is redacted, as before (E14)', async () => {
    const { workspaceDeleteOwn } = await import('./settings.ts')
    const { redactInput } = await import('./define.ts')
    expect(workspaceDeleteOwn.sensitive).toBeUndefined()
    const input = { name: 'Brightwater Plumbing & Heating', keepAccounts: true }
    // The same as with the empty list it had: redactInput leaves the input alone either way.
    expect(redactInput(workspaceDeleteOwn, input)).toBe(input)
    expect(redactInput({ sensitive: [] }, input)).toBe(input)
  })
})

describe('realtime voices', () => {
  it('are the ten voices OpenAI lists for the Realtime API, marin and cedar (recommended) first', () => {
    expect([...REALTIME_VOICE_IDS].sort()).toEqual([
      'alloy',
      'ash',
      'ballad',
      'cedar',
      'coral',
      'echo',
      'marin',
      'sage',
      'shimmer',
      'verse',
    ])
    expect(REALTIME_VOICE_IDS.slice(0, 2)).toEqual(RECOMMENDED_REALTIME_VOICES)
    expect(realtimeVoices.filter(v => v.recommended).map(v => v.id)).toEqual(['marin', 'cedar'])
    // OpenAI gives no gender or accent, only that the voices are optimized for English.
    for (const v of realtimeVoices) expect(v.languages).toEqual([{ code: 'en', accent: null, native: true }])
  })

  it('isRealtimeVoice knows only those', () => {
    expect(isRealtimeVoice('verse')).toBe(true)
    for (const other of ['nova', 'onyx', '', null, undefined, 'MARIN']) expect(isRealtimeVoice(other)).toBe(false)
  })

  it("a call's voice: the assistant's, else the server's default, else marin", () => {
    expect(realtimeVoiceFor('ash', 'cedar')).toBe('ash')
    expect(realtimeVoiceFor('', 'cedar')).toBe('cedar')
    expect(realtimeVoiceFor(null, '  ')).toBe(REALTIME_DEFAULT_VOICE)
    expect(realtimeVoiceFor('not-a-voice', null)).toBe('marin')
  })
})
