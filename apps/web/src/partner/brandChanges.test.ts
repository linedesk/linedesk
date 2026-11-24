import { describe, expect, it } from 'vitest'
import { changedFields } from './brandChanges.ts'

const brand = {
  name: 'Northside Voice',
  logoUrl: '/logo/1.png',
  supportEmail: 'help@northside.example',
  termsUrl: 'https://northside.example/terms',
  privacyUrl: null,
}

describe('brand changes to review', () => {
  it('names only the reviewed fields that differ from the approved brand', () => {
    expect(changedFields(brand, brand)).toEqual([])
    expect(changedFields({ ...brand, supportEmail: 'support@northside.example' }, brand)).toEqual(['supportEmail'])
    expect(changedFields({ ...brand, logoUrl: '/logo/2.png', privacyUrl: 'https://northside.example/p' }, brand)).toEqual(
      ['logo', 'privacyUrl'],
    )
  })

  it('names every field set when nothing is approved yet', () => {
    expect(changedFields(brand, null)).toEqual(['name', 'logo', 'supportEmail', 'termsUrl'])
  })
})
