import { describe, expect, test } from 'vitest'
import {
  abroadWarning,
  dialHref,
  findGuide,
  formatGuideNumber,
  forwardingCountries,
  forwardingGuideById,
  forwardingGuideForCarrier,
  forwardingGuides,
  forwardingInstructions,
  forwardsAbroad,
  guideInCountry,
  guideModes,
  guidesForCountry,
  hasForwardingCountry,
  INTERNATIONAL_SYSTEM_MIN_COUNTRIES,
  isFallbackGuide,
  isInternationalSystem,
  OTHER_COUNTRY,
  otherCountryOption,
  phoneCountry,
  preselectForwardingCountry,
  searchForwardingGuides,
} from './forwarding-guides.ts'

const MAYA = '+15035550142'

/** A mobile number of each country with guides (libphonenumber's examples), to write into its guides' codes. */
const SAMPLE: Record<string, string> = {
  AE: '+971501234567',
  AR: '+5491123456789',
  AT: '+43664123456',
  AU: '+61412345678',
  BE: '+32450001234',
  BR: '+5511961234567',
  CA: '+15062345678',
  CH: '+41781234567',
  CL: '+56221234567',
  CO: '+573211234567',
  DE: '+4915123456789',
  DK: '+4534412345',
  ES: '+34612345678',
  FI: '+358412345678',
  FR: '+33612345678',
  GB: '+447400123456',
  IE: '+353850123456',
  IL: '+972502345678',
  IN: '+918123456789',
  IT: '+393123456789',
  JP: '+819012345678',
  LU: '+352628123456',
  MX: '+522221234567',
  NL: '+31612345678',
  NO: '+4740612345',
  NZ: '+64211234567',
  PH: '+639051234567',
  PL: '+48512345678',
  PT: '+351912345678',
  SE: '+46701234567',
  SG: '+6581234567',
  US: MAYA,
  ZA: '+27711234567',
}

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
        // No way to turn it off only where the carrier publishes none, and then the note says what to do.
        if (steps.off.length === 0) expect(g.note, `${g.id} ${mode} has no off and must say so`).toMatch(/off/)
        if (g.how === 'dial')
          for (const c of g.modes[mode]!.on)
            expect(c.code, `${g.id} ${mode} must put the number in`).toContain('{number}')
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
      const country = g.countries === 'any' ? 'US' : g.countries[0]!
      for (const mode of guideModes(g)) {
        // A number of the guide's own country, written the way the guide asks.
        const steps = forwardingInstructions(g, mode, SAMPLE[country] ?? MAYA)!
        expect(steps.how).toBe('dial')
        if (steps.how !== 'dial') continue
        // Only a guide that writes the number internationally puts a + in it.
        const allowed = g.numberFormat === 'international' ? /^[0-9*#+ ]+$/ : /^[0-9*# ]+$/
        for (const c of [...steps.on, ...steps.off, ...steps.check]) expect(c.code).toMatch(allowed)
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
  'zz-other-mobile': {
    conditional: ['**61*+15035550142#', '**67*+15035550142#', '**62*+15035550142#'],
    all: ['**21*+15035550142#'],
  },
}
// Settings guides: which modes have steps.
const PINNED_SETTINGS_MODES: Record<string, string[]> = {
  cricket: ['forward_conditional', 'forward_all'],
  'us-cellular': ['forward_conditional', 'forward_all'],
  'google-fi': ['forward_all'],
  boost: ['forward_conditional', 'forward_all'],
  'consumer-cellular': ['forward_conditional', 'forward_all'],
  'other-mobile': ['forward_conditional', 'forward_all'],
  'zz-phone-settings': ['forward_conditional', 'forward_all'],
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
  'teams-phone': ['forward_conditional', 'forward_all'],
  aircall: ['forward_all'],
  '3cx': ['forward_conditional', 'forward_all'],
  'webex-calling': ['forward_conditional', 'forward_all'],
  sipgate: ['forward_conditional', 'forward_all'],
  placetel: ['forward_conditional', 'forward_all'],
  nfon: ['forward_conditional', 'forward_all'],
  'de-easybell': ['forward_conditional'],
  cloudtalk: ['forward_conditional', 'forward_all'],
  justcall: ['forward_conditional', 'forward_all'],
}

test('every guide is pinned: the on codes of dialling guides, the modes of settings guides', () => {
  const codes = (g: (typeof forwardingGuides)[number], mode: 'forward_conditional' | 'forward_all') => {
    const steps = forwardingInstructions(g, mode, MAYA)
    return steps?.how === 'dial' ? steps.on.map(c => c.code) : null
  }
  // The US carriers and "Other country"; the other countries are pinned by count and sample below.
  const pinned = forwardingGuides.filter(
    g =>
      g.kind === 'phone_system' ||
      (g.countries !== 'any' && (g.countries.includes('US') || g.countries.includes(OTHER_COUNTRY))),
  )
  const dial = pinned.filter(g => g.how === 'dial')
  expect(
    Object.fromEntries(
      dial.map(g => [g.id, { conditional: codes(g, 'forward_conditional'), all: codes(g, 'forward_all') }]),
    ),
  ).toEqual(PINNED_ON_CODES)
  const settings = pinned.filter(g => g.how === 'settings')
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
  expect(searchForwardingGuides('')).toEqual(guidesForCountry('US'))
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

describe('countries', () => {
  test('every guide names its countries: uppercase ISO codes or any; ids outside the US start with the code', () => {
    for (const g of forwardingGuides) {
      if (g.countries === 'any') {
        expect(g.kind, `${g.id}: only an app or phone system is for any country`).toBe('phone_system')
        continue
      }
      expect(g.countries.length).toBeGreaterThan(0)
      for (const c of g.countries) expect(c).toMatch(/^[A-Z]{2}$/)
      const [only] = g.countries
      if (g.countries.length === 1 && only !== 'US') expect(g.id.startsWith(`${only!.toLowerCase()}-`)).toBe(true)
      expect(g.id).toBe(g.id.toLowerCase())
    }
  })

  test('the countries with carrier guides, and how many each has (cell phones and landlines, the FRITZ!Box across Europe)', () => {
    const counts = Object.fromEntries(
      forwardingCountries.map(c => [c.code, guidesForCountry(c.code).filter(g => g.kind !== 'phone_system').length]),
    )
    expect(counts).toEqual({
      AE: 4,
      AR: 5,
      AT: 5,
      AU: 6,
      BE: 7,
      BR: 5,
      CA: 15,
      CH: 8,
      CL: 6,
      CO: 7,
      DE: 9,
      DK: 8,
      ES: 8,
      FI: 5,
      FR: 9,
      GB: 9,
      IE: 6,
      IL: 5,
      IN: 5,
      IT: 10,
      JP: 6,
      LU: 5,
      MX: 5,
      NL: 6,
      NO: 7,
      NZ: 6,
      PH: 5,
      PL: 8,
      PT: 6,
      SE: 7,
      SG: 5,
      US: 24,
      ZA: 6,
    })
    expect(Object.keys(SAMPLE).sort()).toEqual(forwardingCountries.map(c => c.code).sort())
    expect(otherCountryOption).toEqual({ code: 'ZZ', name: 'Other country' })
    expect(forwardingCountries.map(c => c.code)).not.toContain(OTHER_COUNTRY)
  })

  test('a phone system selling numbers in a country is listed there, and only there', () => {
    const ids = (cc: string) => guidesForCountry(cc).map(g => g.id)
    expect(ids('DE')).toEqual(expect.arrayContaining(['sipgate', 'placetel', 'de-easybell', 'fritzbox', 'ringcentral']))
    expect(ids('DE')).not.toContain('grasshopper')
    expect(ids('US')).toEqual(expect.arrayContaining(['grasshopper', 'nextiva', 'ringcentral', '3cx']))
    expect(ids('US')).not.toContain('sipgate')
    expect(ids('US')).not.toContain('de-easybell')
    // 'any' (a self-hosted system) is in every country, "Other country" included.
    expect(ids(OTHER_COUNTRY)).toContain('3cx')
    // A phone system's countries don't make a country with guides of its own.
    expect(findGuide('cloudtalk')!.countries).toContain('AL')
    expect(forwardingCountries.map(c => c.code)).not.toContain('AL')
    expect(ids('AL')).toEqual(expect.arrayContaining(['zz-other-mobile', 'zz-phone-settings', 'cloudtalk']))
    // Phone systems are listed after the carriers.
    const de = guidesForCountry('DE')
    const firstSystem = de.findIndex(g => g.kind === 'phone_system')
    expect(de.slice(firstSystem).every(g => g.kind === 'phone_system')).toBe(true)
  })

  test('every country has a fallback for any other cell carrier', () => {
    for (const { code } of [...forwardingCountries, otherCountryOption]) {
      const id = code === 'US' ? 'other-mobile' : `${code.toLowerCase()}-other-mobile`
      expect(
        guidesForCountry(code).map(g => g.id),
        code,
      ).toContain(id)
    }
  })

  test('a country gets its own guides, cell phones first, then landlines, then phone systems', () => {
    const us = guidesForCountry('us')
    expect(us.every(g => guideInCountry(g, 'US') || isInternationalSystem(g))).toBe(true)
    expect(us.map(g => g.id)).toContain('verizon')
    expect(us.map(g => g.id)).not.toContain('zz-other-mobile')
    const kinds = us.map(g => g.kind)
    expect(kinds).toEqual([...kinds].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)))
    expect(searchForwardingGuides('', 'US')[0]?.id).toBe('verizon')
  })

  test('a country without guides, and "Other country", get the standard codes, the phone settings and apps for any country', () => {
    const other = guidesForCountry(OTHER_COUNTRY).map(g => g.id)
    expect(other.slice(0, 2)).toEqual(['zz-other-mobile', 'zz-phone-settings'])
    const carriers = (cc: string) =>
      guidesForCountry(cc)
        .filter(g => g.kind !== 'phone_system')
        .map(g => g.id)
    expect(carriers('KR')).toEqual(carriers(OTHER_COUNTRY))
    expect(other).not.toContain('verizon')
    expect(searchForwardingGuides('verizon', 'KR')).toEqual([])
    expect(searchForwardingGuides('verizon', 'FR')).toEqual([])
    const gsm = findGuide('zz-other-mobile')!
    expect(gsm.how === 'dial' && gsm.numberFormat).toBe('international')
    expect(gsm.note).toMatch(/can differ/)
  })

  test('international phone systems are listed in every country, regional ones only in theirs', () => {
    const systems = (cc: string) => guidesForCountry(cc).filter(g => g.kind === 'phone_system').map(g => g.id)
    const international = [
      '8x8',
      '3cx',
      'aircall',
      'cloudtalk',
      'dialpad',
      'google-voice',
      'justcall',
      'teams-phone',
      'nfon',
      'placetel',
      'ringcentral',
      'vonage',
      'webex-calling',
      'zoom-phone',
    ]
    expect(INTERNATIONAL_SYSTEM_MIN_COUNTRIES).toBe(10)
    expect(forwardingGuides.filter(isInternationalSystem).map(g => g.id).sort()).toEqual([...international].sort())
    // Korea has no carrier guides: "Other country" with every international system, A–Z by name.
    expect(hasForwardingCountry('KR')).toBe(false)
    expect(preselectForwardingCountry({ workspaceCountry: 'KR' })).toBe(OTHER_COUNTRY)
    for (const cc of ['KR', OTHER_COUNTRY]) {
      const ids = guidesForCountry(cc).map(g => g.id)
      expect(ids.slice(0, 2)).toEqual(['zz-other-mobile', 'zz-phone-settings'])
      expect(systems(cc)).toEqual(
        forwardingGuides
          .filter(isInternationalSystem)
          .sort((a, b) => a.name.localeCompare(b.name, 'en'))
          .map(g => g.id),
      )
      expect(systems(cc)).toEqual(expect.arrayContaining(['dialpad', '8x8', 'teams-phone', '3cx']))
    }
    // Every country with guides lists them all too, after its regional ones.
    for (const { code } of forwardingCountries) expect(systems(code)).toEqual(expect.arrayContaining(international))
    const us = systems('US')
    expect(us.slice(0, 4)).toEqual(['grasshopper', 'ooma-office', 'nextiva', 'quo'])
    expect(systems('DE').slice(0, 2)).toEqual(['sipgate', 'de-easybell'])
    for (const regional of ['grasshopper', 'ooma-office', 'nextiva', 'quo', 'sipgate', 'de-easybell']) {
      expect(systems(OTHER_COUNTRY)).not.toContain(regional)
      expect(systems('JP')).not.toContain(regional)
    }
    // The FRITZ!Box router: its own countries and the rest of Europe, never elsewhere.
    const ids = (cc: string) => guidesForCountry(cc).map(g => g.id)
    for (const cc of ['DE', 'AT', 'CH', 'NL', 'FR', 'GB', 'PL', 'NO']) expect(ids(cc), cc).toContain('fritzbox')
    for (const cc of ['US', 'JP', OTHER_COUNTRY]) expect(ids(cc), cc).not.toContain('fritzbox')
    expect(forwardingCountries.map(c => c.code)).not.toContain('KR')
  })

  test('a phone system for any country is listed in every country', () => {
    const app = { ...findGuide('grasshopper')!, countries: 'any' as const }
    expect(guideInCountry(app, 'DE')).toBe(true)
    expect(guideInCountry(app, OTHER_COUNTRY)).toBe(true)
    expect(guideInCountry(findGuide('grasshopper')!, 'DE')).toBe(false)
  })

  test('the carrier lookup looks in the country first and falls back to every country', () => {
    expect(forwardingGuideForCarrier('Verizon Wireless', 'US')?.id).toBe('verizon')
    expect(forwardingGuideForCarrier('Verizon Wireless', 'DE')?.id).toBe('verizon')
    expect(forwardingGuideForCarrier('Some Carrier GmbH', 'DE')).toBeUndefined()
    // The same name in several countries: the business line's country decides.
    expect(forwardingGuideForCarrier('Vodafone', 'DE')?.id).toBe('de-vodafone')
    expect(forwardingGuideForCarrier('Vodafone', 'GB')?.id).toBe('gb-vodafone')
    expect(forwardingGuideForCarrier('Orange', 'FR')?.id).toBe('fr-orange')
    expect(forwardingGuideForCarrier('Telekom Deutschland GmbH', 'DE')?.id).toBe('de-telekom')
  })

  test('a lookup never picks a fallback, and the search lists fallbacks after every real carrier', () => {
    for (const { code } of [...forwardingCountries, otherCountryOption]) {
      for (const word of ['other', 'mobile', 'cell', 'gsm', 'settings', 'Other mobile', 'Another cell carrier'])
        expect(forwardingGuideForCarrier(word, code), `${code} ${word}`).toBeUndefined()
      for (const word of ['mobile', 'cell', 'other', 'o']) {
        const found = searchForwardingGuides(word, code)
        const firstFallback = found.findIndex(isFallbackGuide)
        if (firstFallback >= 0) expect(found.slice(firstFallback).every(isFallbackGuide), `${code} ${word}`).toBe(true)
      }
    }
    // A brand that is only an alias of a fallback isn't picked by the lookup either.
    expect(forwardingGuideForCarrier('amaysim', 'AU')).toBeUndefined()
    // In the picker the fallback is still found by its words.
    expect(searchForwardingGuides('other', 'DE').map(g => g.id)).toContain('de-other-mobile')
    for (const id of ['other-mobile', 'de-other-mobile', 'zz-other-mobile', 'zz-phone-settings'])
      expect(isFallbackGuide(findGuide(id)!)).toBe(true)
    expect(isFallbackGuide(findGuide('de-telekom')!)).toBe(false)
  })

  test('the country a number belongs to', () => {
    expect(phoneCountry('+493012345678')).toBe('DE')
    expect(phoneCountry('+442071234567')).toBe('GB')
    expect(phoneCountry(MAYA)).toBe('US')
    expect(phoneCountry(null)).toBeNull()
  })

  test('preselect: the assistant number, then the workspace, then the business number, then the locale, else the US', () => {
    expect(preselectForwardingCountry({ assistantNumber: MAYA, workspaceCountry: 'DE' })).toBe('US')
    expect(preselectForwardingCountry({ assistantNumber: '+493012345678' })).toBe('DE')
    // A number in a country without guides yet opens "Other country".
    expect(preselectForwardingCountry({ assistantNumber: '+82212345678' })).toBe(OTHER_COUNTRY)
    expect(preselectForwardingCountry({ workspaceCountry: 'US', locale: 'de-DE' })).toBe('US')
    expect(preselectForwardingCountry({ workspaceCountry: 'FR' })).toBe('FR')
    expect(preselectForwardingCountry({ workspaceCountry: 'KR' })).toBe(OTHER_COUNTRY)
    expect(preselectForwardingCountry({ businessNumber: MAYA })).toBe('US')
    expect(preselectForwardingCountry({ locale: 'en-US' })).toBe('US')
    // A locale alone only picks a country that has guides.
    expect(preselectForwardingCountry({ locale: 'de-DE' })).toBe('DE')
    expect(preselectForwardingCountry({ locale: 'ko-KR' })).toBe('US')
    expect(preselectForwardingCountry({})).toBe('US')
  })

  test('forwarding goes abroad when the number has another calling code than the country', () => {
    expect(forwardsAbroad(MAYA, 'US')).toBe(false)
    expect(forwardsAbroad('+14165550199', 'US')).toBe(false)
    expect(forwardsAbroad('+493012345678', 'US')).toBe(true)
    expect(forwardsAbroad(MAYA, 'DE')).toBe(true)
    expect(forwardsAbroad(MAYA, OTHER_COUNTRY)).toBe(false)
  })

  test('the abroad warning says it won’t work for a carrier that forwards only within its country', () => {
    const ee = findGuide('gb-ee')!
    expect(ee.domesticOnly).toBe(true)
    expect(abroadWarning(MAYA, 'GB', ee)).toMatchObject({ kind: 'blocked', text: expect.stringMatching(/won’t work/) })
    expect(abroadWarning(MAYA, 'GB', ee)?.text).toContain('United Kingdom')
    // Another carrier: it goes abroad, which can cost extra.
    expect(abroadWarning(MAYA, 'GB', findGuide('gb-vodafone'))).toMatchObject({ kind: 'abroad' })
    expect(abroadWarning(MAYA, 'GB')).toMatchObject({ kind: 'abroad', text: expect.stringMatching(/cost extra/) })
    // A number of the line's own country: nothing to say.
    expect(abroadWarning(SAMPLE.GB!, 'GB', ee)).toBeNull()
    expect(abroadWarning(MAYA, 'US', findGuide('verizon'))).toBeNull()
    expect(abroadWarning(MAYA, OTHER_COUNTRY)).toBeNull()
    // Same calling code, other country: a Canadian carrier that forwards within Canada only refuses a US number.
    const freedom = findGuide('ca-freedom')!
    expect(freedom.domesticOnly).toBe(true)
    expect(abroadWarning(MAYA, 'CA', freedom)).toMatchObject({ kind: 'blocked' })
    expect(abroadWarning(MAYA, 'CA', findGuide('ca-rogers'))).toBeNull()
  })

  test('the carriers known to forward only within their country are flagged', () => {
    const flagged = forwardingGuides.filter(g => g.domesticOnly).map(g => g.id)
    expect(flagged).toEqual(
      expect.arrayContaining([
        'de-1und1',
        'gb-ee',
        'ie-vodafone',
        'ch-salt',
        'nl-kpn-vast',
        'be-base',
        'nz-one-nz',
        'in-jio',
        'ae-eand',
        'sg-m1-digital-voice',
        'jp-softbank',
        'jp-rakuten',
      ]),
    )
    for (const g of forwardingGuides.filter(g => g.domesticOnly)) {
      expect(g.kind, g.id).not.toBe('phone_system')
      expect(g.countries === 'any' ? 0 : g.countries.length, g.id).toBe(1)
    }
    // POST forwards to five countries: said in the note, not flagged.
    expect(findGuide('lu-post')!.domesticOnly).toBeFalsy()
    expect(findGuide('lu-post')!.note).toMatch(/Belgium/)
    // Vodafone Australia prepaid can't forward at all.
    expect(findGuide('au-vodafone')!.pitfalls.join(' ')).toMatch(/prepaid/i)
  })
})

const ORDER = ['mobile', 'landline', 'phone_system']

describe('writing the number', () => {
  const DE = '+493012345678'
  const GB = '+442071234567'
  const AU = '+61291234567'

  test.each([
    // [number, format, country, written]
    [MAYA, 'ten', 'US', '5035550142'],
    [MAYA, 'eleven', 'US', '15035550142'],
    [MAYA, 'national', 'US', '5035550142'],
    [MAYA, 'international', 'US', '+15035550142'],
    [GB, 'national', 'GB', '02071234567'],
    [GB, 'international', 'GB', '+442071234567'],
    [DE, 'national', 'DE', '03012345678'],
    [DE, 'international', 'DE', '+493012345678'],
    [AU, 'national', 'AU', '0291234567'],
    [AU, 'international', 'AU', '+61291234567'],
    // The national significant number: no trunk prefix, no country code (Brazil, India).
    [SAMPLE.BR!, 'nsn', 'BR', '11961234567'],
    [SAMPLE.IN!, 'nsn', 'IN', '8123456789'],
    [DE, 'nsn', 'DE', '3012345678'],
    [MAYA, 'nsn', 'US', '5035550142'],
  ] as const)('%s as %s from %s: %s', (e164, format, country, written) => {
    expect(formatGuideNumber(e164, format, country)).toBe(written)
  })

  test('a number of another country is always written internationally', () => {
    expect(formatGuideNumber(DE, 'national', 'GB')).toBe('+493012345678')
    expect(formatGuideNumber(DE, 'ten', 'US')).toBe('+493012345678')
    expect(formatGuideNumber(DE, 'eleven')).toBe('+493012345678')
    expect(formatGuideNumber(MAYA, 'national', 'DE')).toBe('+15035550142')
    expect(formatGuideNumber(DE, 'nsn', 'BR')).toBe('+493012345678')
    // A Canadian number dialled in the US stays 10 digits.
    expect(formatGuideNumber('+14165550199', 'ten', 'US')).toBe('4165550199')
  })

  test('without a country, national is the number’s own national format', () => {
    expect(formatGuideNumber(DE, 'national')).toBe('03012345678')
    expect(formatGuideNumber(DE, 'national', OTHER_COUNTRY)).toBe('03012345678')
  })

  test('the instructions write the number for the country picked', () => {
    const tmobile = findGuide('tmobile')!
    expect(forwardingInstructions(tmobile, 'forward_all', DE, 'US')).toMatchObject({
      on: [{ code: '**21*+493012345678#' }],
    })
    const gsm = findGuide('zz-other-mobile')!
    expect(forwardingInstructions(gsm, 'forward_all', DE, OTHER_COUNTRY)).toMatchObject({
      on: [{ code: '**21*+493012345678#', href: 'tel:**21*%2B493012345678%23' }],
    })
  })

  test('codes of other countries, written the way each carrier asks', () => {
    const on = (id: string, mode: 'forward_conditional' | 'forward_all', e164: string) => {
      const steps = forwardingInstructions(findGuide(id)!, mode, e164)
      return steps?.how === 'dial' ? steps.on.map(c => c.code) : null
    }
    // TIM Brasil: 0, the carrier code 41, then area code and number.
    expect(on('br-tim', 'forward_all', SAMPLE.BR!)).toEqual(['*21*04111961234567#'])
    expect(on('in-vi', 'forward_all', SAMPLE.IN!)?.[0]).toContain('8123456789#')
    expect(on('de-telekom', 'forward_all', SAMPLE.DE!)?.[0]).toContain('+4915123456789')
    expect(on('gb-vodafone', 'forward_all', SAMPLE.GB!)?.[0]).toContain('+447400123456')
    // Bouygues sets every-call forwarding in its voice menu: no code, the note says how.
    expect(on('fr-bouygues', 'forward_all', SAMPLE.FR!)).toBeNull()
    expect(findGuide('fr-bouygues')!.note).toMatch(/610/)
  })

  test('PLDT publishes no off codes: the instructions have none, and the note says to ask PLDT', () => {
    const steps = forwardingInstructions(findGuide('ph-pldt')!, 'forward_all', SAMPLE.PH!)
    expect(steps).toMatchObject({ how: 'dial', off: [] })
    expect(findGuide('ph-pldt')!.note).toMatch(/ask PLDT/i)
  })

  test('settings steps write a number outside North America internationally', () => {
    const steps = forwardingInstructions(findGuide('zz-phone-settings')!, 'forward_all', DE, OTHER_COUNTRY)
    expect(steps?.on.join(' ')).toContain('+49 30 12345678')
  })
})
