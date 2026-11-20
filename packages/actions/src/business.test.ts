// The default texts a new assistant starts with, in the workspace's language: the greeting in every language calls are
// answered in (spoken-lines.ts); the About labels and the common-calls templates in German, else English. The German
// wording was approved by Janik on 2026-11-20 (CLAUDE.md rule 11): these tests hold it word for word.
import { describe, expect, test } from 'vitest'
import {
  aboutLabelsIn,
  businessTemplateIds,
  businessTemplates,
  greetingFor,
  templateUseCasesAnyLanguage,
  templateUseCasesIn,
} from './business.ts'
import { spokenLines } from './spoken-lines.ts'

const B = 'Brightwater Plumbing & Heating'

describe('greetingFor', () => {
  test('English stays exactly as before', () => {
    const english = 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'
    expect(greetingFor(B, 'Maya')).toBe(english)
    expect(greetingFor(B, 'Maya', 'en')).toBe(english)
    // A language calls are not answered in, or none: English.
    expect(greetingFor(B, 'Maya', 'xx')).toBe(english)
    expect(greetingFor(B, 'Maya', null)).toBe(english)
  })

  test('German: the approved greeting with the AI note', () => {
    expect(greetingFor(B, 'Maya', 'de')).toBe(
      'Danke für Ihren Anruf bei Brightwater Plumbing & Heating. Hier ist Maya, die KI-Assistenz. Wie kann ich helfen?',
    )
  })

  test('every other spoken-lines language: its default greeting with the AI note', () => {
    for (const language of ['es', 'fr'])
      expect(greetingFor(` ${B} `, ' Maya ', language)).toBe(spokenLines(language).greeting(B, 'Maya', true))
  })
})

describe('About labels', () => {
  test('German, else English', () => {
    expect(aboutLabelsIn('de')).toEqual({
      services: 'Leistungen:',
      area: 'Einsatzgebiet:',
      address: 'Adresse:',
      commonCalls: 'Häufige Anrufe:',
    })
    for (const language of ['en', 'fr', null])
      expect(aboutLabelsIn(language)).toEqual({
        services: 'Services:',
        area: 'Service area:',
        address: 'Address:',
        commonCalls: 'Common calls:',
      })
  })
})

describe('common-calls templates', () => {
  test('German plumbing, word for word', () => {
    expect(templateUseCasesIn('plumbing_hvac', 'de')).toEqual([
      'Wenn jemand anruft und einen Wasserschaden, eine Überschwemmung oder keine Heizung hat, behandle es als dringend: nimm Adresse und Telefonnummer auf und markiere die Nachricht als dringend.',
      'Wenn jemand eine Reparatur oder einen Kostenvoranschlag möchte, frag, was nicht funktioniert, nach der Adresse und wann die Person zu Hause ist.',
      'Wenn jemand nach Preisen fragt, nenne die Preise, die du kennst, und biete sonst einen Rückruf für ein Angebot an.',
    ])
  })

  test('every German template starts with the urgent line', () => {
    expect(templateUseCasesIn('law_office', 'de')[0]).toBe(
      'Wenn jemand anruft und in den nächsten Tagen eine Gerichtsfrist hat, behandle es als dringend: nimm Name, Telefonnummer und die Frist auf und markiere die Nachricht als dringend.',
    )
    expect(templateUseCasesIn('other', 'de')).toEqual([
      'Wenn jemand anruft und etwas hat, das nicht warten kann, behandle es als dringend: nimm Name und Telefonnummer auf und markiere die Nachricht als dringend.',
      'Wenn jemand mit einer Person sprechen möchte, nimm Name, Telefonnummer und das Anliegen für einen Rückruf auf.',
      'Wenn jemand nach Preisen oder Öffnungszeiten fragt, antworte mit dem, was du weißt.',
    ])
    for (const id of businessTemplateIds) {
      const german = templateUseCasesIn(id, 'de')
      expect(german[0], id).toMatch(
        /^Wenn jemand anruft und .*, behandle es als dringend: nimm .* auf und markiere die Nachricht als dringend\.$/,
      )
      expect(german.length, id).toBe(businessTemplates[id].useCases.length)
      expect(templateUseCasesAnyLanguage(id), id).toEqual([...businessTemplates[id].useCases, ...german])
    }
  })

  test('every other language: the English templates, unchanged', () => {
    for (const id of businessTemplateIds)
      for (const language of ['en', 'fr', null])
        expect(templateUseCasesIn(id, language)).toBe(businessTemplates[id].useCases)
  })
})
