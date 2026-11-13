import { describe, expect, test } from 'vitest'
import {
  dialHref,
  forwardingGuideById,
  forwardingGuideForCarrier,
  forwardingGuides,
  forwardingInstructions,
  guideModes,
  searchForwardingGuides,
} from './forwarding-guides.ts'

const MAYA = '+15035550142'

describe('guide data', () => {
  test('ids are unique, and the three the carrier lookup names exist', () => {
    const ids = forwardingGuides.map(g => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['verizon', 'att', 'tmobile']) expect(forwardingGuideById(id)).toBeDefined()
  })

  test.each(forwardingGuides.map(g => [g.id, g] as const))(
    '%s: on and off for every mode it claims, with a source',
    (_id, g) => {
      const modes = guideModes(g)
      // Every guide can do something, or says what to do instead.
      expect(modes.length > 0 || !!g.note).toBe(true)
      if (modes.length < 2) expect(g.note, `${g.id} lacks a mode and must say so`).toBeTruthy()
      for (const mode of modes) {
        const steps = g.modes[mode]!
        expect(steps.on.length).toBeGreaterThan(0)
        expect(steps.off.length).toBeGreaterThan(0)
        const text = JSON.stringify(steps.on)
        expect(text, `${g.id} ${mode} must put the number in`).toMatch(/\{number\}|\{digits\}/)
      }
      expect(g.sources.length).toBeGreaterThan(0)
      for (const s of g.sources) {
        expect(s.url).toMatch(/^https:\/\/[^\s]+$/)
        expect(s.label.trim()).not.toBe('')
      }
      expect(g.name.trim()).not.toBe('')
      for (const alias of g.aliases) expect(alias).toBe(alias.toLowerCase())
    },
  )

  test('dial codes are made of what a dialer takes', () => {
    for (const g of forwardingGuides) {
      if (g.how !== 'dial') continue
      for (const mode of guideModes(g)) {
        const steps = forwardingInstructions(g, mode, MAYA)!
        expect(steps.how).toBe('dial')
        if (steps.how !== 'dial') continue
        for (const c of [...steps.on, ...steps.off, ...steps.check]) expect(c.code).toMatch(/^[0-9*# ]+$/)
      }
    }
  })

  test('only mobile and landline lines dial; phone systems change a setting', () => {
    for (const g of forwardingGuides) if (g.kind === 'phone_system') expect(g.how).toBe('settings')
  })
})

// Every code each dialling guide produces for +1 503 555 0142, pinned, so a change to a code or the number format is
// deliberate and checked against the guide's source (10 digits, or 11 with the 1 where the carrier writes it so).
const PINNED_ON_CODES: Record<string, { conditional: string[] | null; all: string[] | null }> = {
  verizon: { conditional: ['*715035550142'], all: ['*725035550142'] },
  visible: { conditional: ['*715035550142'], all: ['*725035550142'] },
  'spectrum-mobile': { conditional: ['*715035550142'], all: ['*725035550142'] },
  'xfinity-mobile': { conditional: ['*715035550142'], all: ['*725035550142'] },
  'total-wireless': { conditional: null, all: ['*725035550142'] },
  'straight-talk': { conditional: null, all: ['*725035550142'] },
  att: { conditional: ['**61*5035550142**20#', '**67*5035550142#', '**62*5035550142#'], all: ['*21*5035550142#'] },
  tmobile: {
    conditional: ['**61*15035550142**20#', '**67*15035550142#', '**62*15035550142#'],
    all: ['**21*15035550142#'],
  },
  metro: {
    conditional: ['**61*15035550142**20#', '**67*15035550142#', '**62*15035550142#'],
    all: ['**21*15035550142#'],
  },
  mint: { conditional: ['**61*15035550142#', '**67*15035550142#', '**62*15035550142#'], all: ['**21*15035550142#'] },
  'us-mobile-warp': { conditional: ['*715035550142'], all: ['*725035550142'] },
  'us-mobile-light-speed': { conditional: ['**61*5035550142#'], all: ['**21*5035550142#'] },
  'us-mobile-dark-star': {
    conditional: ['*61*5035550142#', '*67*5035550142#', '*62*5035550142#'],
    all: ['*21*5035550142#'],
  },
  'comcast-business': { conditional: ['*92 5035550142', '*90 5035550142'], all: ['*72 5035550142'] },
  'att-business-line': { conditional: ['*925035550142#', '*905035550142#'], all: ['*725035550142#'] },
  'verizon-landline': { conditional: ['*92 5035550142'], all: ['*72 5035550142'] },
  'cox-business': { conditional: ['*92 5035550142', '*90 5035550142'], all: ['*72 5035550142'] },
}
// Settings guides: which modes have steps.
const PINNED_SETTINGS_MODES: Record<string, string[]> = {
  cricket: ['forward_conditional', 'forward_all'],
  'us-cellular': ['forward_conditional', 'forward_all'],
  'google-fi': ['forward_all'],
  boost: ['forward_conditional', 'forward_all'],
  'consumer-cellular': ['forward_conditional', 'forward_all'],
  'other-mobile': ['forward_conditional', 'forward_all'],
  'spectrum-business': ['forward_conditional', 'forward_all'],
  ringcentral: ['forward_conditional', 'forward_all'],
  'google-voice': ['forward_all'],
  grasshopper: ['forward_conditional', 'forward_all'],
  'ooma-office': ['forward_all'],
  vonage: ['forward_conditional', 'forward_all'],
  dialpad: ['forward_conditional'],
  '8x8': ['forward_conditional', 'forward_all'],
  nextiva: ['forward_conditional', 'forward_all'],
  quo: ['forward_conditional', 'forward_all'],
  'zoom-phone': ['forward_conditional'],
}

test('every guide is pinned: the on codes of dialling guides, the modes of settings guides', () => {
  const codes = (g: (typeof forwardingGuides)[number], mode: 'forward_conditional' | 'forward_all') => {
    const steps = forwardingInstructions(g, mode, MAYA)
    return steps?.how === 'dial' ? steps.on.map(c => c.code) : null
  }
  const dial = forwardingGuides.filter(g => g.how === 'dial')
  expect(
    Object.fromEntries(
      dial.map(g => [g.id, { conditional: codes(g, 'forward_conditional'), all: codes(g, 'forward_all') }]),
    ),
  ).toEqual(PINNED_ON_CODES)
  const settings = forwardingGuides.filter(g => g.how === 'settings')
  expect(Object.fromEntries(settings.map(g => [g.id, guideModes(g)]))).toEqual(PINNED_SETTINGS_MODES)
})

test('settings steps get digits where the system expects digits', () => {
  const steps = forwardingInstructions(forwardingGuideById('8x8')!, 'forward_conditional', MAYA)
  expect(steps?.on.join(' ')).toContain('Forward Directly To” › 15035550142.')
  expect(steps?.on.join(' ')).not.toContain('1(503)')
})

describe('instructions', () => {
  test('Verizon: one code each, *73 turns both off', () => {
    const verizon = forwardingGuideById('verizon')!
    expect(forwardingInstructions(verizon, 'forward_conditional', MAYA)).toEqual({
      how: 'dial',
      on: [{ code: '*715035550142', when: 'Calls you miss', href: 'tel:*715035550142' }],
      off: [{ code: '*73', href: 'tel:*73' }],
      check: [],
    })
    expect(forwardingInstructions(verizon, 'forward_all', MAYA)).toMatchObject({ on: [{ code: '*725035550142' }] })
  })

  test('T-Mobile: 11 digits, no answer after 20 seconds, busy, unreachable; status check', () => {
    const steps = forwardingInstructions(forwardingGuideById('tmobile')!, 'forward_conditional', MAYA)
    expect(steps?.how === 'dial' && steps.on.map(c => c.code)).toEqual([
      '**61*15035550142**20#',
      '**67*15035550142#',
      '**62*15035550142#',
    ])
    expect(steps?.how === 'dial' && steps.off.map(c => c.code)).toEqual(['##61#', '##67#', '##62#'])
    expect(steps?.how === 'dial' && steps.check.map(c => c.code)).toEqual(['*#61#', '*#21#'])
  })

  test('AT&T uses its own every-call code and 10 digits', () => {
    const steps = forwardingInstructions(forwardingGuideById('att')!, 'forward_all', MAYA)
    expect(steps).toMatchObject({ on: [{ code: '*21*5035550142#' }], off: [{ code: '#21#' }] })
  })

  test('a landline code keeps the pause for the tone in the code, not in the tel: link', () => {
    const steps = forwardingInstructions(forwardingGuideById('comcast-business')!, 'forward_conditional', MAYA)
    expect(steps).toMatchObject({
      on: [{ code: '*92 5035550142', href: 'tel:*925035550142' }, { code: '*90 5035550142' }],
    })
  })

  test('phone systems get numbered steps with the number written out', () => {
    const steps = forwardingInstructions(forwardingGuideById('ringcentral')!, 'forward_conditional', MAYA)
    expect(steps?.how).toBe('settings')
    expect(steps?.on.join(' ')).toContain('(503) 555-0142')
    expect(steps?.on.join(' ')).not.toContain('{number}')
  })

  test('a mode the line cannot do has no instructions', () => {
    expect(forwardingInstructions(forwardingGuideById('google-fi')!, 'forward_conditional', MAYA)).toBeNull()
    expect(forwardingInstructions(forwardingGuideById('total-wireless')!, 'forward_conditional', MAYA)).toBeNull()
  })
})

test('tel: links escape # (it would end the URL) and keep *', () => {
  expect(dialHref('**61*15035550142**20#')).toBe('tel:**61*15035550142**20%23')
  expect(dialHref('##004#')).toBe('tel:%23%23004%23')
  expect(dialHref('*72 5035550142')).toBe('tel:*725035550142')
})

describe('finding the guide for a carrier name', () => {
  test.each([
    ['Verizon Wireless', 'verizon'],
    ['Cellco Partnership dba Verizon Wireless', 'verizon'],
    ['T-Mobile USA, Inc.', 'tmobile'],
    ['Sprint Spectrum L.P.', 'tmobile'],
    ['AT&T Mobility', 'att'],
    ['New Cingular Wireless PCS, LLC', 'att'],
    ['Cricket Wireless', 'cricket'],
    ['Metro by T-Mobile', 'metro'],
    ['MetroPCS', 'metro'],
    ['Spectrum Mobile', 'spectrum-mobile'],
    ['Spectrum Business', 'spectrum-business'],
    ['Comcast Business', 'comcast-business'],
    ['OpenPhone', 'quo'],
    ['Google Voice', 'google-voice'],
    ['Google Fi', 'google-fi'],
  ])('%s → %s', (name, id) => {
    expect(forwardingGuideForCarrier(name)?.id).toBe(id)
  })

  test('wholesale networks and empty names find nothing', () => {
    expect(forwardingGuideForCarrier('Bandwidth.com CLEC')).toBeUndefined()
    expect(forwardingGuideForCarrier('Onvoy, LLC')).toBeUndefined()
    // Home lines must not get business codes.
    expect(forwardingGuideForCarrier('Comcast Cable Communications')).toBeUndefined()
    expect(forwardingGuideForCarrier('Charter Communications')).toBeUndefined()
    expect(forwardingGuideForCarrier('')).toBeUndefined()
    expect(forwardingGuideForCarrier(null)).toBeUndefined()
  })
})

test('the picker search finds by name, former name and network', () => {
  expect(searchForwardingGuides('').length).toBe(forwardingGuides.length)
  expect(searchForwardingGuides('openphone').map(g => g.id)).toEqual(['quo'])
  expect(searchForwardingGuides('metro').map(g => g.id)).toEqual(['metro'])
  expect(searchForwardingGuides('t-mob').map(g => g.id)).toEqual(['tmobile', 'metro', 'mint', 'us-mobile-dark-star'])
  expect(searchForwardingGuides('ring')[0]?.id).toBe('ringcentral')
  expect(searchForwardingGuides('verizon').map(g => g.id)).toEqual(
    expect.arrayContaining(['verizon', 'visible', 'total-wireless', 'verizon-landline']),
  )
  expect(
    searchForwardingGuides('verizon')
      .slice(0, 2)
      .map(g => g.id),
  ).toEqual(['verizon', 'verizon-landline'])
})
