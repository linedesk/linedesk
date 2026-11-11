import type { KnowledgeImportData } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import type { Draft } from './assistantDraft.ts'
import { applyImport, defaultPicks, reviewImport, wordDiff } from './knowledgeModel.ts'

const draft = (over: Partial<Draft> = {}) =>
  ({ instructions: '', services: [], faqs: [], website: '', ...over }) as unknown as Draft
const proposal = (over: Partial<KnowledgeImportData> = {}): KnowledgeImportData => ({
  about: 'We fix pipes in Portland.',
  services: [],
  faqs: [],
  useCases: [],
  pages: [],
  website: 'https://brightwater.example',
  ...over,
})

describe('word diff', () => {
  it('marks what was added and removed, keeps the rest', () => {
    expect(wordDiff('We fix pipes', 'We fix leaky pipes')).toEqual([
      { kind: 'same', text: 'We fix ' },
      { kind: 'added', text: 'leaky ' },
      { kind: 'same', text: 'pipes' },
    ])
    expect(wordDiff('a b', 'a c').map(p => p.kind)).toEqual(['same', 'removed', 'added'])
  })
})

describe('import review', () => {
  it('fills an empty About and adds new items by default', () => {
    const p = proposal({
      services: [{ name: 'Drains', description: '', price: '$149' }],
      faqs: [{ q: 'Weekends?', a: 'Saturdays.' }],
    })
    const review = reviewImport(draft(), p)
    expect(review.about).toBe('empty')
    const next = applyImport(draft(), p, review, defaultPicks(review, p))
    expect(next.instructions).toBe('We fix pipes in Portland.')
    expect(next.services).toEqual([{ name: 'Drains', description: '', price: '$149' }])
    expect(next.faqs).toHaveLength(1)
    expect(next.website).toBe('https://brightwater.example')
  })

  it("never overwrites the owner's edits unless picked: a different About and changed prices start unpicked", () => {
    const mine = draft({
      instructions: 'My own words.',
      services: [{ name: 'Drains', description: '', price: '$129' }],
      faqs: [{ q: 'weekends', a: 'No.' }],
    })
    const p = proposal({
      services: [{ name: 'drains', description: '', price: '$149' }],
      faqs: [{ q: 'Weekends?', a: 'Saturdays.' }],
    })
    const review = reviewImport(mine, p)
    expect(review.about).toBe('different')
    expect(review.services[0]).toMatchObject({ status: 'changed', was: { price: '$129' } })
    const picks = defaultPicks(review, p)
    expect(applyImport(mine, p, review, picks)).toMatchObject({
      instructions: 'My own words.',
      services: [{ price: '$129' }],
      faqs: [{ a: 'No.' }],
    })
    // Picked: the change replaces the item in place, no duplicate.
    const taken = applyImport(mine, p, review, {
      about: true,
      useCases: new Set<number>(),
      services: new Set([0]),
      faqs: new Set([0]),
    })
    expect(taken.services).toEqual([{ name: 'drains', description: '', price: '$149' }])
    expect(taken.faqs).toEqual([{ q: 'Weekends?', a: 'Saturdays.' }])
    expect(taken.instructions).toBe('We fix pipes in Portland.')
  })

  it('items the draft already has as they are are not offered again', () => {
    const mine = draft({
      instructions: 'We fix pipes in Portland.',
      services: [{ name: 'Drains', description: 'Sinks', price: '$149' }],
    })
    const review = reviewImport(mine, proposal({ services: [{ name: 'Drains', description: '', price: '$149' }] }))
    expect(review).toEqual({ about: 'same', services: [], faqs: [], unchanged: 1 })
  })
})

describe('use cases', () => {
  it('picked ones are added under "Common calls" after the About text, also when the owner keeps their own text', () => {
    const p = proposal({
      useCases: [
        'When a caller smells gas, flag it urgent.',
        'When a caller asks for a price, say the team sends a quote.',
      ],
    })
    const mine = draft({ instructions: 'My own words.' })
    const review = reviewImport(mine, p)
    const kept = applyImport(mine, p, review, { ...defaultPicks(review, p), useCases: new Set([0]) })
    expect(kept.instructions).toBe('My own words.\n\nCommon calls:\n- When a caller smells gas, flag it urgent.')
    const none = applyImport(mine, p, review, { ...defaultPicks(review, p), useCases: new Set() })
    expect(none.instructions).toBe('My own words.')
  })
})
