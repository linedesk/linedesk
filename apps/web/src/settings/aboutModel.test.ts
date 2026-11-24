import { describe, expect, test } from 'vitest'
import { answeredFrom, checkAbout, joinAbout, keyAfter, newQuestion, parseAbout } from './aboutModel.ts'

const TEXT = [
  'We fix pipes in Portland.',
  'Service area: Portland, Beaverton.',
  'If a caller asks "Do you come to Hillsboro?": Yes, at no extra charge.',
  'If a caller asks "My water heater is leaking?": Turn off the valve. We come the same day.',
].join('\n')

describe('parseAbout and joinAbout', () => {
  test('rows for question lines, the rest is the business text; an unchanged text comes back byte for byte', () => {
    const parts = parseAbout(TEXT)
    expect(parts.profile).toBe('We fix pipes in Portland.\nService area: Portland, Beaverton.')
    expect(parts.questions.map(q => q.question)).toEqual(['Do you come to Hillsboro?', 'My water heater is leaking?'])
    expect(parts.questions[1]!.answer).toBe('Turn off the valve. We come the same day.')
    expect(joinAbout(parts)).toBe(TEXT)
  })

  test('an edited row is written as an answered line; an empty new row is left out', () => {
    const parts = parseAbout(TEXT)
    const questions = parts.questions.map((q, i) => (i === 0 ? { ...q, answer: 'Yes,  every   day.' } : q))
    const text = joinAbout({ ...parts, questions: [...questions, newQuestion(1)] })
    expect(text.split('\n')[2]).toBe('If a caller asks "Do you come to Hillsboro?": Yes, every day.')
    expect(text.split('\n')).toHaveLength(4)
  })

  test('question lines between business lines move after them', () => {
    const text = 'Line one.\nIf a caller asks "Q?": A.\nLine two.'
    expect(joinAbout(parseAbout(text))).toBe('Line one.\nLine two.\nIf a caller asks "Q?": A.')
  })
})

describe('checkAbout', () => {
  test('near duplicates, long answers and another language', () => {
    const text = [
      'We are a plumbing company and we fix pipes for you.',
      'If a caller asks "Do you install tankless water heaters?": Yes, every brand.',
      'If a caller asks "Can you install a tankless water heater?": Yes, from $2,800.',
      `If a caller asks "Do you clear drains?": ${'We clear drains the same day. '.repeat(20)}`,
      'If a caller asks "Kann ich einen Termin machen?": Ja, die Wartung ist am Montag und kostet 129 $ mit Anfahrt.',
    ].join('\n')
    const parts = parseAbout(text)
    const kinds = checkAbout(parts).map(i => [parts.questions.find(q => q.key === i.key)!.question, i.kind])
    expect(kinds).toEqual([
      ['Can you install a tankless water heater?', 'duplicate'],
      ['Do you clear drains?', 'long'],
      ['Kann ich einen Termin machen?', 'language'],
    ])
  })
})

test('answeredFrom: the row that shares the most words, else none', () => {
  const parts = parseAbout(TEXT)
  expect(answeredFrom(parts, 'Is my water heater leaking?', 'Turn off the valve on the heater.')?.question).toBe(
    'My water heater is leaking?',
  )
  expect(answeredFrom(parts, 'Do you sell pizza?', 'I can take a message.')).toBeNull()
})

test('keyAfter: the open row keeps its row when an earlier one is merged away or a new one gets its answer', () => {
  const parts = parseAbout(TEXT)
  const [first, second] = parts.questions
  const merged = { ...parts, questions: [{ ...second!, answer: 'Merged.' }] }
  expect(keyAfter(merged, second!.key)).toBe('q0')
  expect(parseAbout(joinAbout(merged)).questions[0]!.answer).toBe('Merged.')
  const added = { ...parts, questions: [...parts.questions, { ...newQuestion(1), question: 'New?', answer: 'Yes.' }] }
  expect(keyAfter(added, 'new1')).toBe('q2')
  const cleared = { ...parts, questions: [{ ...first!, answer: '' }, second!] }
  expect(keyAfter(cleared, first!.key)).toBe('dq0')
})
