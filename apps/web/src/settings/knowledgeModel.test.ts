import type { KnowledgeImportData } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import type { Draft } from './assistantDraft.ts'
import { applyImport, defaultPicks, reviewImport, wordDiff } from './knowledgeModel.ts'

const draft = (over: Partial<Draft> = {}) =>
  ({ instructions: '', website: '', ...over }) as unknown as Draft
const proposal = (over: Partial<KnowledgeImportData> = {}): KnowledgeImportData => ({
  about: 'We fix pipes in Portland.',
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
  it('fills an empty About by default', () => {
    const p = proposal()
    const review = reviewImport(draft(), p)
    expect(review.about).toBe('empty')
    const next = applyImport(draft(), p, defaultPicks(review, p))
    expect(next.instructions).toBe('We fix pipes in Portland.')
    expect(next.website).toBe('https://brightwater.example')
  })

  it("never overwrites the owner's own About unless picked", () => {
    const mine = draft({ instructions: 'My own words.' })
    const p = proposal()
    const review = reviewImport(mine, p)
    expect(review.about).toBe('different')
    expect(applyImport(mine, p, defaultPicks(review, p)).instructions).toBe('My own words.')
    expect(applyImport(mine, p, { about: true, useCases: new Set<number>() }).instructions).toBe('We fix pipes in Portland.')
  })

  it('the same About is not offered again', () => {
    expect(reviewImport(draft({ instructions: 'We fix pipes in Portland.' }), proposal())).toEqual({ about: 'same' })
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
    const kept = applyImport(mine, p, { ...defaultPicks(review, p), useCases: new Set([0]) })
    expect(kept.instructions).toBe('My own words.\n\nCommon calls:\n- When a caller smells gas, flag it urgent.')
    const none = applyImport(mine, p, { ...defaultPicks(review, p), useCases: new Set() })
    expect(none.instructions).toBe('My own words.')
  })
})
