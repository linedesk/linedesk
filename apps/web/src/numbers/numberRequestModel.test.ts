// What the number request screens show (numberRequestModel.ts): stages, which requests get a line, the number as
// written, reasons, the profile form and its checks, documents.
import type { RegulatoryProfileInput } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import {
  areaAwayFromAddress,
  canCancel,
  canCheck,
  documentProblem,
  documentsByKind,
  draftOf,
  forgetUnsentDraft,
  keepUnsentDraft,
  unsentDraft,
  holdReason,
  listedAreas,
  missingDocuments,
  profileFromDraft,
  type RequestRow,
  rejectionReason,
  requestedNumber,
  requestStage,
  requestView,
  sameProfile,
  shownFields,
  shownRequests,
  websiteOf,
} from './numberRequestModel.ts'

const row = (over: Partial<RequestRow>): RequestRow => ({
  id: 'nr_1',
  country: 'DE',
  prefix: '30',
  city: 'berlin',
  areaName: 'Berlin',
  status: 'pending_review',
  reason: null,
  e164: '+493023125678',
  phoneNumberId: null,
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  ...over,
})

const profile: RegulatoryProfileInput = {
  legal_name: 'Brightwater Sanitär GmbH',
  entity_type: 'business',
  registration_number: 'HRB 123456 B',
  address: { street: 'Hauptstraße 1', city: 'Berlin', postal_code: '10115', country: 'DE' },
  contact: { first_name: 'Mike', last_name: 'Brennan', email: 'mike@brightwater.test', phone: '+493055500100' },
}

describe('where a request stands', () => {
  test('stages: in review until the carrier decides, setting up once approved, on hold when it could not be', () => {
    expect(['requested', 'submitted', 'pending_review'].map(s => requestStage(s as never))).toEqual([
      'review',
      'review',
      'review',
    ])
    expect(requestStage('approved')).toBe('settingUp')
    expect(requestStage('needs_operator')).toBe('onHold')
    expect(holdReason('bill_inactive')).toBe('bill')
    expect(holdReason('routing_failed')).toBe('admin')
    expect(requestStage('rejected')).toBe('rejected')
  })

  test('cancel only before the carrier decided; check also while it is set up', () => {
    expect(canCancel('pending_review')).toBe(true)
    expect(canCancel('approved')).toBe(false)
    expect(canCheck('approved')).toBe(true)
    expect(canCheck('needs_operator')).toBe(true)
    expect(canCheck('rejected')).toBe(false)
  })

  test('the lines: no active or cancelled request, and a rejected one only until it was sent again', () => {
    const rejected = row({ id: 'a', status: 'rejected', createdAt: '2026-11-10T00:00:00Z' })
    const again = row({ id: 'b', createdAt: '2026-11-12T00:00:00Z' })
    const otherCity = row({ id: 'c', status: 'rejected', prefix: '89', city: 'munich' })
    const done = row({ id: 'd', status: 'active' })
    const cancelled = row({ id: 'e', status: 'cancelled' })
    expect(shownRequests([again, rejected, otherCity, done, cancelled]).map(r => r.id)).toEqual(['b', 'c'])
    expect(shownRequests([rejected]).map(r => r.id)).toEqual(['a'])
  })
})

describe('words', () => {
  test('the number as written in the country, the area code while none is reserved', () => {
    expect(requestedNumber('DE', '30', '+493023125678')).toBe('+49 30 23125678')
    expect(requestedNumber('GB', '20', '+442071234567')).toBe('+44 20 71234567')
    expect(requestedNumber('DE', '221', null)).toBe('0221')
  })

  test('our reason codes become keys, the carrier words stay, none says so', () => {
    expect(rejectionReason('requirements_declined')).toEqual({ key: 'declined' })
    expect(rejectionReason(' Wrong address ')).toEqual({ text: 'Wrong address' })
    expect(rejectionReason(null)).toEqual({ key: 'none' })
  })
})

describe('the profile form', () => {
  test('starts from the saved profile, else from the workspace and the person', () => {
    expect(draftOf(profile, { country: 'US' })).toMatchObject({ legal_name: profile.legal_name, city: 'Berlin' })
    expect(
      draftOf(null, { country: 'DE', legalName: 'Brightwater', name: 'Mike Brennan', email: 'mike@x.test' }),
    ).toMatchObject({ legal_name: 'Brightwater', first_name: 'Mike', last_name: 'Brennan', country: 'DE' })
  })

  test('round trip: the saved profile comes back the same, and is then not saved again', () => {
    const result = profileFromDraft(draftOf(profile, { country: 'DE' }), ['legal_name', 'registration_number'])
    expect(result).toEqual({ input: profile })
    expect(sameProfile(profile, 'input' in result ? result.input : profile)).toBe(true)
    expect(sameProfile(null, profile)).toBe(false)
  })

  test('marks what is missing or wrong; a field the country asks for is required', () => {
    const draft = { ...draftOf(null, { country: 'DE' }), email: 'not-an-email', phone: '+49' }
    const result = profileFromDraft(draft, ['registration_number'])
    expect('problems' in result && result.problems).toMatchObject({
      legal_name: 'required',
      registration_number: 'required',
      email: 'email',
      phone: 'phone',
    })
    // Ireland does not ask for the registration number: not required there.
    const ie = profileFromDraft({ ...draftOf(profile, { country: 'IE' }), registration_number: '' }, ['use_case'])
    expect('problems' in ie && ie.problems).toEqual({ use_case: 'required' })
  })

  test('a website without https:// gets it; a word is no web address', () => {
    expect(websiteOf('brightwater.de')).toBe('https://brightwater.de')
    const bad = profileFromDraft({ ...draftOf(profile, { country: 'GB' }), website: 'brightwater' }, ['website'])
    expect('problems' in bad && bad.problems.website).toBe('website')
  })

  test('shows the optional fields only where the country asks for them', () => {
    expect(shownFields(['registration_number']).has('website')).toBe(false)
    expect(shownFields(['website', 'use_case']).has('use_case')).toBe(true)
  })

  test('the register court is its own field next to the register number, shown where the number is asked for', () => {
    const saved = { ...profile, registration_number: 'HRB 751915', register_court: 'Amtsgericht Mannheim' }
    const draft = draftOf(saved, { country: 'DE' })
    expect(draft).toMatchObject({ register_court: 'Amtsgericht Mannheim', registration_number: 'HRB 751915' })
    expect(profileFromDraft(draft, ['registration_number'])).toEqual({ input: saved })
    // Optional: left empty, it is not sent.
    expect(profileFromDraft({ ...draft, register_court: '' }, ['registration_number'])).toEqual({
      input: { ...profile, registration_number: 'HRB 751915' },
    })
    expect(shownFields(['registration_number']).has('register_court')).toBe(true)
    expect(shownFields(['use_case']).has('register_court')).toBe(false)
  })

  test('a German postcode has five digits', () => {
    const bad = profileFromDraft({ ...draftOf(profile, { country: 'DE' }), postal_code: '1011' }, [])
    expect('problems' in bad && bad.problems.postal_code).toBe('postcode')
    expect(
      'input' in
        profileFromDraft({ ...draftOf(profile, { country: 'GB' }), postal_code: 'SW1A 1AA', country: 'GB' }, []),
    ).toBe(true)
  })
})

describe('the area list', () => {
  const area = (prefix: string, name: string, available = true) => ({ prefix, name, popular: false, available })
  const heidelberg = area('6221', 'Heidelberg')
  const berlin = area('30', 'Berlin')
  const ulm = area('731', 'Ulm', false)

  test('the picked area and, with nothing typed, the address areas come first, each once', () => {
    expect(listedAreas([berlin, heidelberg], [heidelberg], null, '').map(a => a.prefix)).toEqual(['6221', '30'])
    expect(listedAreas([berlin, ulm], [heidelberg], ulm, '').map(a => a.prefix)).toEqual(['731', '6221', '30'])
    // A search lists what it found; the picked area stays visible on top.
    expect(listedAreas([ulm], [heidelberg], berlin, 'ulm').map(a => a.prefix)).toEqual(['30', '731'])
  })

  test('another area than the address is only told, and only when the address has an area', () => {
    expect(areaAwayFromAddress('30', [heidelberg])).toBe(true)
    expect(areaAwayFromAddress('6221', [heidelberg])).toBe(false)
    expect(areaAwayFromAddress('30', [])).toBe(false)
  })
})

describe("where the country's newest request stands (onboarding)", () => {
  test('none, in review (also while approved and set up), rejected, active', () => {
    const r = (status: RequestRow['status'], country: RequestRow['country'] = 'DE') =>
      row({ id: status, status, country })
    expect(requestView('DE', []).kind).toBe('none')
    expect(requestView('DE', [r('pending_review', 'GB')]).kind).toBe('none')
    expect(requestView('DE', [r('cancelled'), r('rejected')]).kind).toBe('none')
    expect(requestView('DE', [r('pending_review')]).kind).toBe('review')
    expect(requestView('DE', [r('approved')]).kind).toBe('review')
    expect(requestView('DE', [r('needs_operator')]).kind).toBe('review')
    expect(requestView('DE', [r('rejected')]).kind).toBe('rejected')
    expect(requestView('DE', [r('active')]).kind).toBe('active')
  })
})

describe('documents', () => {
  test('PDF, PNG or JPEG of at most 2.5 MB', () => {
    expect(documentProblem({ type: 'application/pdf', size: 1000 })).toBeNull()
    expect(documentProblem({ type: 'image/heic', size: 1000 })).toBe('type')
    expect(documentProblem({ type: 'image/png', size: 2_500_001 })).toBe('size')
    expect(documentProblem({ type: 'image/jpeg', size: 0 })).toBe('empty')
  })

  test('grouped by kind, newest first; the kinds without one are missing', () => {
    const doc = (id: string, kind: 'id_or_registration' | 'proof_of_address', createdAt: string) => ({
      id,
      kind,
      filename: `${id}.pdf`,
      contentType: 'application/pdf',
      size: 10,
      createdAt,
    })
    const docs = [doc('old', 'proof_of_address', '2026-11-01'), doc('new', 'proof_of_address', '2026-11-02')]
    expect(documentsByKind(['proof_of_address'], docs)[0]!.documents.map(d => d.id)).toEqual(['new', 'old'])
    expect(missingDocuments(['id_or_registration', 'proof_of_address', 'bnetza_form'], docs)).toEqual([
      'id_or_registration',
      'bnetza_form',
    ])
  })
})

describe('the business details of a request that was not sent', () => {
  test('come back when the form opens again (Cancel, then reopen), like the uploaded documents; sending forgets them', () => {
    const typed = { ...draftOf(null, { country: 'DE' }), legal_name: 'Sanitär Dossenheim GmbH', city: 'Dossenheim' }
    expect(unsentDraft('ws_1')).toBeNull()
    keepUnsentDraft('ws_1', typed)
    expect(unsentDraft('ws_1')).toEqual(typed)
    // Another workspace (another tab) starts from its own.
    expect(unsentDraft('ws_2')).toBeNull()
    expect(unsentDraft(null)).toBeNull()
    forgetUnsentDraft('ws_1')
    expect(unsentDraft('ws_1')).toBeNull()
  })
})
