// Personal data out of support mail before a language model reads it (LIN-642).
import { describe, expect, test } from 'vitest'
import { namesOf, redactPersonal, stripQuoted } from './redact.ts'

describe('redactPersonal', () => {
  test('addresses, numbers, links and names become placeholders; prices and times stay', () => {
    const text =
      'Hi Jane,\nmy heater at 412 Oak St leaks. Call (503) 555-0142 or +1 503.555.0142, mail jane.porter@example.com, ' +
      'card 4111 1111 1111 1111, photos at https://photos.example/x. Quote was $3,200 to $4,800, 199,000 BTU, ' +
      'between 2 and 5 pm.\nThanks,\nJane Porter'
    expect(redactPersonal(text, namesOf('Jane Porter <jane.porter@example.com>'))).toBe(
      'Hi [name],\nmy heater at [address] leaks. Call [phone] or [phone], mail [email], card [number], photos at [link] ' +
        'Quote was $3,200 to $4,800, 199,000 BTU, between 2 and 5 pm.\nThanks,\n[name]',
    )
  })

  test('sign-offs lose the name, a plain "Thanks a lot" stays', () => {
    expect(redactPersonal('Thanks, Jane')).toBe('Thanks, [name]')
    expect(redactPersonal('Best regards,\nMike')).toBe('Best regards,\n[name]')
    expect(redactPersonal('Thanks a lot')).toBe('Thanks a lot')
  })

  test('names of the people in the conversation, wherever they stand', () => {
    expect(redactPersonal('This is Dave from 5th street, Dave Kim', ['Dave', 'Kim'])).toBe(
      'This is [name] from 5th street, [name] [name]',
    )
  })
})

describe('stripQuoted', () => {
  test('cuts the quote of the earlier mail', () => {
    expect(stripQuoted('Friday works.\n\nOn Tue, Jan 7, 2030 at 9:00 AM Jane <j@example.com> wrote:\n> old')).toBe(
      'Friday works.',
    )
    expect(stripQuoted('Yes.\n-----Original Message-----\nFrom: x')).toBe('Yes.')
    expect(stripQuoted('Yes.\n> quoted line\nmore')).toBe('Yes.\nmore')
  })
})

describe('namesOf', () => {
  test('the words of the display name', () => {
    expect(namesOf('"Porter, Jane" <jane@example.com>')).toEqual(['Porter', 'Jane'])
    expect(namesOf('jane@example.com')).toEqual([])
  })
})
