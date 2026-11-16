import { describe, expect, it } from 'vitest'
import {
  insertMention,
  matchPeople,
  mentionedPeople,
  mentionPeople,
  mentionQuery,
  offersToAdd,
  pieces,
  toCanonical,
  toDisplay,
} from './callEmailsModel.ts'

const members = [
  { userId: 'u_dave', name: 'Dave Ortiz', email: 'dave@brightwater.example', emailOn: true },
  { userId: 'u_sarah', name: 'Sarah Kim', email: 'sarah@brightwater.example', emailOn: false },
  { userId: 'u_mike', name: 'Mike Brennan', email: 'mike@brightwater.example', emailOn: true },
  { userId: 'u_old', name: 'Old Hand', email: 'old@brightwater.example', disabled: true },
]
const stored =
  'Water heaters go to <@user:u_dave>. Billing to <@user:u_sarah> and <@email:rosa@lakeside-books.example>.'
const people = mentionPeople(members, ['rosa@lakeside-books.example'], stored, 'A teammate')

describe('display and stored text', () => {
  it('shows tokens as names and addresses', () => {
    expect(toDisplay(stored, people)).toBe(
      'Water heaters go to @Dave Ortiz. Billing to @Sarah Kim and @rosa@lakeside-books.example.',
    )
  })
  it('turns the shown text back into the same tokens', () => {
    expect(toCanonical(toDisplay(stored, people), people)).toBe(stored)
  })
  it('keeps a token of someone unknown as it is, both ways', () => {
    const text = 'Also <@user:u_gone> please'
    expect(toDisplay(text, people)).toBe(text)
    expect(toCanonical(text, people)).toBe(text)
  })
  it('keeps an address the instruction names that is no longer on the list', () => {
    const text = 'To <@email:gone@shop.example>'
    const withGone = mentionPeople(members, [], text, 'A teammate')
    expect(toCanonical(toDisplay(text, withGone), withGone)).toBe(text)
  })
  it('does not take a longer word or a plain address for a mention', () => {
    expect(toCanonical('@Dave Ortizz and bob@Dave Ortiz', people)).toBe('@Dave Ortizz and bob@Dave Ortiz')
    expect(toCanonical('@rosa@lakeside-books.example.com', people)).toBe('@rosa@lakeside-books.example.com')
  })
  it('makes two members with the same name tell apart by their address', () => {
    const twins = mentionPeople(
      [
        { userId: 'a', name: 'Sam', email: 'sam1@x.example' },
        { userId: 'b', name: 'Sam', email: 'sam2@x.example' },
      ],
      [],
      '',
      'A teammate',
    )
    expect(twins.map(p => p.label)).toEqual(['Sam (sam1@x.example)', 'Sam (sam2@x.example)'])
    expect(toCanonical('@Sam (sam2@x.example) only', twins)).toBe('<@user:b> only')
  })
  it('splits the text into plain pieces and mentions for the highlight layer', () => {
    expect(pieces('Hi @Mike Brennan and @rosa@lakeside-books.example', people)).toEqual([
      { text: 'Hi ' },
      { text: '@Mike Brennan', mention: { kind: 'user' } },
      { text: ' and ' },
      { text: '@rosa@lakeside-books.example', mention: { kind: 'email' } },
    ])
  })
})

describe('typing a mention', () => {
  it('finds the words typed after an @', () => {
    expect(mentionQuery('Billing to @Sa', 14, people)).toEqual({ at: 11, query: 'Sa' })
    expect(mentionQuery('@', 1, people)).toEqual({ at: 0, query: '' })
  })
  it('opens nothing inside an address, on a new line or right after a finished mention', () => {
    expect(mentionQuery('mail bob@sh', 11, people)).toBeNull()
    expect(mentionQuery('@Da\nx', 5, people)).toBeNull()
    expect(mentionQuery('to @Dave Ortiz', 14, people)).toBeNull()
  })
  it('stays closed after a pick adds its space, unless a longer name still fits', () => {
    expect(mentionQuery('to @Dave Ortiz ', 15, people)).toBeNull()
    expect(mentionQuery('to @Dave Ortiz and', 18, people)).toBeNull()
    const both = [...people, { kind: 'user' as const, id: 'u9', label: 'Dave', email: 'd@x.example' }]
    expect(mentionQuery('to @Dave ', 9, both)).toEqual({ at: 3, query: 'Dave ' })
  })
  it('matches names and addresses, members first, never disabled members', () => {
    expect(matchPeople('', people).map(p => p.label)).toEqual([
      'Dave Ortiz',
      'Mike Brennan',
      'Sarah Kim',
      'rosa@lakeside-books.example',
    ])
    expect(matchPeople('sarah@', people).map(p => p.label)).toEqual(['Sarah Kim'])
    expect(matchPeople('old', people)).toEqual([])
  })
  it('offers to add an address nobody has', () => {
    expect(offersToAdd('new@shop.example', people)).toBe(true)
    expect(offersToAdd('rosa@lakeside-books.example', people)).toBe(false)
    expect(offersToAdd('mike@brightwater.example', people)).toBe(false)
    expect(offersToAdd('new@shop', people)).toBe(false)
  })
  it('puts the picked person in place of the typed words', () => {
    const dave = people[0]!
    expect(insertMention('Go to @Da', 6, 9, dave)).toEqual({ text: 'Go to @Dave Ortiz ', caret: 18 })
    expect(insertMention('Go to @Da.', 6, 9, dave)).toEqual({ text: 'Go to @Dave Ortiz.', caret: 17 })
  })
  it('lists everyone named once, in order', () => {
    expect(mentionedPeople(`${stored} <@user:u_dave> <@user:u_gone>`, people).map(p => p.label)).toEqual([
      'Dave Ortiz',
      'Sarah Kim',
      'rosa@lakeside-books.example',
    ])
  })
})
