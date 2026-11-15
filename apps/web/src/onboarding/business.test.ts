import { type BusinessImportData, businessTemplates, templateFor } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  draftFrom,
  draftProblem,
  draftProblems,
  instructionsOf,
  looksLikeWebsite,
  manualProposal,
  profileSave,
  providerProblem,
  renameBusiness,
  savedProposal,
  sourcesLine,
  switchTemplate,
  templateUseCases,
  websiteChoice,
} from './business.ts'

const proposal = (over: Partial<BusinessImportData> = {}): BusinessImportData => ({
  name: 'Brightwater Plumbing & Heating',
  address: '1200 SE Main St, Portland, OR 97214, USA',
  area: 'Portland metro',
  phone: '+1 503-555-0142',
  website: 'https://brightwater-plumbing.example',
  hours: [{ weekday: 1, start: '07:00', end: '18:00' }],
  hoursText: ['Monday: 7:00 AM – 6:00 PM'],
  timeZone: 'America/Los_Angeles',
  template: 'plumbing_hvac',
  services: ['Drain cleaning', 'Water heaters'],
  about: 'We are a family plumbing company.',
  useCases: ['When a caller asks about water heaters, offer a free estimate.'],
  greeting: 'Thanks for calling Brightwater Plumbing & Heating. This is Maya. How can I help?',
  pages: [{ url: 'https://www.brightwater-plumbing.example/', title: 'Home' }],
  notes: [],
  failures: [],
  ...over,
})

test('a website or a name to search for', () => {
  for (const site of ['brightwater-plumbing.example', 'https://x.org', 'www.brightwater.co/contact', 'HTTP://A.B'])
    expect(looksLikeWebsite(site), site).toBe(true)
  for (const name of ['Brightwater Plumbing, Portland', 'Dr. Smith Dental', 'Joe', 'St. Johns Hardware'])
    expect(looksLikeWebsite(name), name).toBe(false)
})

describe('industry templates', () => {
  test('picked from the Google category first, then the name, else none (the owner chooses)', () => {
    expect(templateFor({ primaryType: 'plumber', name: 'Smile Dental' })).toBe('plumbing_hvac')
    expect(templateFor({ primaryType: 'point_of_interest', types: ['establishment', 'hair_salon'] })).toBe('salon_spa')
    expect(templateFor({ name: 'Lakeside Dental' })).toBe('dental_medical')
    expect(templateFor({ name: 'Baker & Sons Law' })).toBe('law_office')
    expect(templateFor({ name: 'Northside Electric' })).toBe('home_services')
    expect(templateFor({ name: 'The Corner Bookshop' })).toBeNull()
  })

  test('each template is a few lines, what is urgent first; no 911 line (every prompt has it) and no transfer promise', () => {
    for (const [id, t] of Object.entries(businessTemplates)) {
      expect(t.useCases[0], id).toMatch(/, treat it as urgent: take .* and mark the message urgent\.$/)
      expect(t.useCases.join('\n'), id).not.toMatch(/911|gas smell|put them through/)
      expect(t.useCases.length, id).toBeGreaterThan(0)
      expect(t.useCases.length, id).toBeLessThanOrEqual(4)
    }
  })

  test('defaults first, then what the website gave, without duplicates', () => {
    const site = [
      'When a caller asks about water heaters, offer a free estimate.',
      businessTemplates.plumbing_hvac.useCases[0]!,
    ]
    expect(templateUseCases('plumbing_hvac', site)).toEqual([...businessTemplates.plumbing_hvac.useCases, site[0]])
  })

  test("switching swaps the template's lines and keeps the owner's own", () => {
    const draft = {
      ...draftFrom(proposal()),
      useCases: `${draftFrom(proposal()).useCases}\nWhen a caller asks for Mike, take a message.`,
    }
    const salon = switchTemplate(draft, 'salon_spa')
    const lines = salon.useCases.split('\n')
    expect(lines.slice(0, businessTemplates.salon_spa.useCases.length)).toEqual([
      ...businessTemplates.salon_spa.useCases,
    ])
    expect(lines).toContain('When a caller asks for Mike, take a message.')
    expect(lines).toContain('When a caller asks about water heaters, offer a free estimate.')
    // The plumbing lines go; no template has a 911 line (every prompt has the emergency rule).
    for (const plumbing of businessTemplates.plumbing_hvac.useCases) expect(lines).not.toContain(plumbing)
    expect(lines.filter(l => l.includes('911'))).toHaveLength(0)
  })
})

describe('the review draft', () => {
  test('hours are offered on only when Google has them', () => {
    expect(draftFrom(proposal()).useHours).toBe(true)
    expect(draftFrom(proposal({ hours: null, hoursText: [] })).useHours).toBe(false)
  })

  test('without a listing or website: no kind of business until the owner chooses, and a greeting with the name', () => {
    const p = manualProposal('  Lakeside Dental ', 'Ava')
    expect(p).toMatchObject({ name: 'Lakeside Dental', template: null, hours: null })
    expect(draftFrom(p).useCases).toBe('')
    const chosen = switchTemplate(draftFrom(p), 'dental_medical')
    expect(chosen.useCases.split('\n')).toEqual([...businessTemplates.dental_medical.useCases])
    expect(p.greeting).toBe('Thanks for calling Lakeside Dental. This is Ava. How can I help?')
  })

  test('renaming the business renames it in the greeting', () => {
    const renamed = renameBusiness(draftFrom(proposal()), 'Brightwater Plumbing')
    expect(renamed.greeting).toBe('Thanks for calling Brightwater Plumbing. This is Maya. How can I help?')
  })

  test('a name is needed; phone and website, when given, must be one, each said under its field', () => {
    expect(draftProblem(draftFrom(proposal()))).toBeNull()
    expect(draftProblem({ ...draftFrom(proposal()), name: ' ' })).toMatch(/name/)
    expect(draftProblems({ ...draftFrom(proposal()), phone: 'abc', website: 'not a url' })).toEqual({
      phone: expect.stringMatching(/phone number/),
      website: expect.stringMatching(/website address/),
    })
    expect(draftProblems({ ...draftFrom(proposal()), phone: '', website: '' })).toEqual({})
    // The phone field's value: any country, but whole
    expect(draftProblems({ ...draftFrom(proposal()), phone: '+4930123456' })).toEqual({})
    expect(draftProblems({ ...draftFrom(proposal()), phone: '+4930' })).toEqual({
      phone: "This number doesn't look complete for Germany.",
    })
  })

  test('coming back: the review starts from the saved profile, and saving it again keeps it', () => {
    const first = profileSave(draftFrom(proposal()), {}, 'Brightwater Plumbing & Heating').assistant.business_profile
    const again = savedProposal(first, 'Brightwater Plumbing & Heating', 'Hi')
    expect(again).toMatchObject({
      phone: '+1 503-555-0142',
      website: 'https://brightwater-plumbing.example',
      template: null,
    })
    expect(again.useCases).toEqual(draftFrom(proposal()).useCases.split('\n'))
    const resaved = profileSave(draftFrom(again), first, 'Brightwater Plumbing & Heating').assistant.business_profile
    expect(resaved).toMatchObject({ phone: first.phone, website: first.website, address: first.address })
    // A field left empty keeps what was saved.
    const emptied = profileSave({ ...draftFrom(again), phone: '', website: '' }, first, 'x').assistant.business_profile
    expect(emptied).toMatchObject({ phone: first.phone, website: first.website })
  })

  test('the About text: brief, services, area, address and the common calls', () => {
    const text = instructionsOf({ ...draftFrom(proposal()), useCases: '- When a caller is rude, stay calm.\n\n' })
    expect(text).toBe(
      [
        'We are a family plumbing company.',
        'Services: Drain cleaning; Water heaters.',
        'Service area: Portland metro.',
        'Address: 1200 SE Main St, Portland, OR 97214, USA.',
        'Common calls:\n- When a caller is rude, stay calm.',
      ].join('\n\n'),
    )
  })
})

describe('saving', () => {
  test('the profile keeps what was saved before, and the hours only when kept', () => {
    const saved = { instructions: 'old', website: 'https://old.example', faqs: [] }
    const result = profileSave(draftFrom(proposal()), saved, 'Brightwater Plumbing & Heating')
    expect(result.assistant.greeting).toBe(
      'Thanks for calling Brightwater Plumbing & Heating. This is Maya. How can I help?',
    )
    expect(result.assistant.business_profile).toMatchObject({
      faqs: [],
      description: 'We are a family plumbing company.',
      services: ['Drain cleaning', 'Water heaters'],
      service_area: 'Portland metro',
      phone: '+1 503-555-0142',
      website: 'https://brightwater-plumbing.example',
      hours: 'Monday: 7:00 AM – 6:00 PM',
    })
    expect(result.assistant.business_profile.instructions).toContain('Common calls:')
    expect(result.hours).toEqual([{ weekday: 1, start: '07:00', end: '18:00' }])
    expect(result.timeZone).toBe('America/Los_Angeles')

    expect(result.rename).toBeNull()

    // Without "Use these hours", Google's hours stay out of the profile too.
    const without = profileSave({ ...draftFrom(proposal()), useHours: false }, saved, 'Brightwater Plumbing & Heating')
    expect(without.hours).toBeNull()
    expect(without.timeZone).toBeNull()
    expect(without.assistant.business_profile).not.toHaveProperty('hours')
  })

  test('a changed business name renames the workspace', () => {
    const draft = renameBusiness(draftFrom(proposal()), 'Brightwater Plumbing ')
    expect(profileSave(draft, {}, 'Brightwater Plumbing & Heating').rename).toBe('Brightwater Plumbing')
    expect(profileSave(draft, {}, 'Brightwater Plumbing').rename).toBeNull()
  })

  test('empty fields are left out, not saved as empty', () => {
    const { business_profile } = profileSave(draftFrom(manualProposal('Joe', 'Maya')), {}, 'Joe').assistant
    expect(Object.keys(business_profile)).not.toContain('address')
    expect(Object.keys(business_profile)).not.toContain('phone')
    expect(Object.values(business_profile)).not.toContain(undefined)
  })
})

test('where the proposal came from', () => {
  expect(sourcesLine(proposal().pages, true)).toBe(
    'From your Google Business Profile and 1 page of brightwater-plumbing.example. Check it and change anything.',
  )
  expect(sourcesLine([], false)).toBe('Check it and change anything.')
  expect(sourcesLine([], true)).toBe('From your Google Business Profile. Check it and change anything.')
  const pages = [proposal().pages[0]!, { url: 'https://brightwater-plumbing.example/services', title: 'Services' }]
  expect(sourcesLine(pages, false)).toBe('From 2 pages of brightwater-plumbing.example. Check it and change anything.')
})

describe('websiteChoice', () => {
  test('the website field only where it can be read; else a quiet line or nothing, never a field to clear', () => {
    expect(websiteChoice('on', false, false)).toBe('field')
    expect(websiteChoice(undefined, false, false)).toBe('field')
    expect(websiteChoice('paused', false, false)).toBe('paused')
    expect(websiteChoice('paused', true, false)).toBe('paused')
    expect(websiteChoice('no_model', true, false)).toBe('needs_model')
    expect(websiteChoice('no_model', false, false)).toBe('hidden')
    expect(websiteChoice('on', true, true)).toBe('hidden')
  })

  test('continuing without reading keeps the website typed', () => {
    expect(manualProposal('Brightwater', 'Maya', ' brightwater.com ').website).toBe('brightwater.com')
    expect(manualProposal('Brightwater', 'Maya').website).toBeNull()
  })
})

test('a provider the step could not use says what happened and, for admins, where to fix it', () => {
  const refused = providerProblem({ provider: 'business', reason: 'auth' }, 'search')
  expect(refused.text).toMatch(/Google refused this server's key\. Enter your details yourself\.$/)
  expect(refused.adminFix).toBe('onboarding.business.problem.fixCheckKey')
  // The link goes to the group that fixes it.
  expect(refused.group).toBe('business')
  expect(providerProblem({ provider: 'business', reason: 'config' }, 'listing').text).toMatch(/Fill in the rest below/)
  expect(providerProblem({ provider: 'llm', reason: 'config' }, 'search')).toEqual({
    text: 'Reading your website needs a language model.',
    adminFix: 'onboarding.business.problem.fixSetOneUp',
    group: 'answering',
  })
})
