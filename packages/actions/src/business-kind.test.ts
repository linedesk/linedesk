import { describe, expect, test } from 'vitest'
import {
  appointmentSuggestionsFor,
  businessKindInfo,
  businessKinds,
  suggestedAppointmentTypeIds,
  suggestedAppointmentTypes,
} from './business-kind.ts'

describe('suggested appointment types', () => {
  test('every kind whose callers book has 2 to 4, except other; the rest have none', () => {
    for (const kind of businessKinds) {
      const books = businessKindInfo[kind].traits.includes('appointments')
      const list = appointmentSuggestionsFor(kind)
      if (books && kind !== 'other') {
        expect(list.length, kind).toBeGreaterThanOrEqual(2)
        expect(list.length, kind).toBeLessThanOrEqual(4)
      } else expect(list, kind).toEqual([])
    }
  })

  test('only kinds that book have a list at all', () => {
    for (const kind of Object.keys(suggestedAppointmentTypes) as (keyof typeof suggestedAppointmentTypes)[])
      expect(businessKindInfo[kind].traits, kind).toContain('appointments')
  })

  test('no kind: no suggestions', () => {
    expect(appointmentSuggestionsFor(null)).toEqual([])
    expect(appointmentSuggestionsFor(undefined)).toEqual([])
  })

  test('a kind names a type once, with a length between 15 minutes and 4 hours', () => {
    for (const list of Object.values(suggestedAppointmentTypes)) {
      expect(new Set(list.map(s => s.type)).size).toBe(list.length)
      for (const s of list) {
        expect(s.durationMin).toBeGreaterThanOrEqual(15)
        expect(s.durationMin).toBeLessThanOrEqual(240)
      }
    }
  })

  test('every listed type is suggested somewhere', () => {
    const used = new Set(Object.values(suggestedAppointmentTypes).flatMap(list => list.map(s => s.type)))
    expect([...suggestedAppointmentTypeIds].filter(id => !used.has(id))).toEqual([])
  })

  test('plumbing and heating', () => {
    expect(appointmentSuggestionsFor('plumbing_hvac').slice(0, 3)).toEqual([
      { type: 'repair_visit', durationMin: 60 },
      { type: 'estimate_visit', durationMin: 30 },
      { type: 'water_heater_service', durationMin: 120 },
    ])
  })
})
