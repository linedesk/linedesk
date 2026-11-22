import { ReadableStream } from 'node:stream/web'
import { describe, expect, it } from 'vitest'
import { spellCodes, spellCodesTransform } from './spoken-codes.ts'

describe('spellCodes', () => {
  it.each([
    ['Ich habe Ihre Nummer 017680652309 notiert.', 'Ich habe Ihre Nummer 0 1 7 6 8 0 6 5 2 3 0 9 notiert.'],
    ['Ihre Nummer 0176 80652309, richtig?', 'Ihre Nummer 0 1 7 6 8 0 6 5 2 3 0 9, richtig?'],
    ['Call us at (503) 555-0142.', 'Call us at 5 0 3 5 5 5 0 1 4 2.'],
    ['I have (503) 555-0142, right?', 'I have 5 0 3 5 5 5 0 1 4 2, right?'],
    ['Or +49 176 8065230.', 'Or plus 4 9 1 7 6 8 0 6 5 2 3 0.'],
    ['Die Sendungsnummer ist CF115804157DE.', 'Die Sendungsnummer ist C F 1 1 5 8 0 4 1 5 7 D E.'],
    ['Job BW-5821 is on the way.', 'Job B W 5 8 2 1 is on the way.'],
    ['Ihre Bestellung mit der Nummer 8252 wurde geliefert.', 'Ihre Bestellung mit der Nummer 8 2 5 2 wurde geliefert.'],
    ['Your order 1038 shipped.', 'Your order 1 0 3 8 shipped.'],
    ['Order #1042 shipped.', 'Order #1 0 4 2 shipped.'],
    ['Die Bestellung 8564 wurde versandt.', 'Die Bestellung 8 5 6 4 wurde versandt.'],
  ])('spaces out %s', (text, spoken) => expect(spellCodes(text)).toBe(spoken))

  it.each([
    'Geliefert am 14. November 2026.',
    'Der Betrag ist 49,90 € und 1.250,00 € insgesamt.',
    'It costs $1,299.99 or $699.95.',
    'Your appointment is on 12/03 at 2:30 PM, or 10am.',
    'Ihr Termin ist am 03.12.2026 um 14:30 Uhr.',
    'We are open 8 to 5, the 3rd floor, 24/7.',
    'Between 2 and 4 PM, about 45 minutes.',
    'Returns within 30 days.',
  ])('keeps %s', text => expect(spellCodes(text)).toBe(text))

  it('uses the text in front of it', () =>
    expect(spellCodes('8252 wurde geliefert.', 'Bestellung ')).toBe('8 2 5 2 wurde geliefert.'))
})

async function streamed(chunks: string[]): Promise<string[]> {
  const out: string[] = []
  const reader = spellCodesTransform(ReadableStream.from(chunks)).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

describe('spellCodesTransform', () => {
  it('spaces out a code split across chunks', async () => {
    const out = await streamed(['Ich habe Ihre Nummer 0176 806', '52309 notiert. Kann ich ', 'sonst noch helfen?'])
    expect(out.join('')).toBe('Ich habe Ihre Nummer 0 1 7 6 8 0 6 5 2 3 0 9 notiert. Kann ich sonst noch helfen?')
  })

  it('sends text without digits at once, up to its last word', async () => {
    const out = await streamed(['Gerne, ich ', 'habe das notiert', '. Bis bald!'])
    expect(out[0]).toBe('Gerne, ich ')
    expect(out.join('')).toBe('Gerne, ich habe das notiert. Bis bald!')
  })

  it('keeps the code word in front of a number in another chunk', async () => {
    const out = await streamed(['Your order', ' 10', '38 was delivered on November 6. Anything else?'])
    expect(out.join('')).toBe('Your order 1 0 3 8 was delivered on November 6. Anything else?')
  })

  it('does not cut at the dot of a German date', async () => {
    const out = await streamed(['Die Bestellung 8252 wurde am 14. Nov', 'ember geliefert.'])
    expect(out.join('')).toBe('Die Bestellung 8 2 5 2 wurde am 14. November geliefert.')
  })

  it('spaces out letters that come before the digits in another chunk', async () => {
    const out = await streamed(['Die Sendungsnummer ist CF', '115804157DE.'])
    expect(out.join('')).toBe('Die Sendungsnummer ist C F 1 1 5 8 0 4 1 5 7 D E.')
  })
})
