// Codes said one character at a time (LIN-757): a voice reads a phone number, an order number or a tracking code as one
// big number or garbles it ("8252" → "achthundertfünf zwei", a German call on 2026-11-22; OpenAI's speech model read
// "8252" as "acht zwei zwei fünf"). With a space between the characters ("8 2 5 2", "C F 1 1 5") every voice provider
// reads them one by one, in the call's language. Prices, dates, times and years stay as written: the voice reads those.
import { ReadableStream } from 'node:stream/web'

/** Words a code follows ("order 1038", "Nr. 8252"): then a number of any length is a code, not an amount or a year. */
const CODE_WORDS =
  /(?:#|\b(?:number|no|nr|order|job|ticket|case|invoice|account|zip|code|nummer|bestellung|bestellnummer|auftrag|auftragsnummer|rechnung|rechnungsnummer|kundennummer|plz|postleitzahl|n[uú]mero|pedido|commande|num[eé]ro|factura|facture))\.?:?\s*$/i

/** A phone number: groups of digits apart by a space, dash, slash or brackets, 7 digits or more in all (not dots: dates). */
const PHONE = /(?<![\w.,])(?:\+\s?)?\(?\d+\)?(?:[ \-/]{1,2}\(?\d+\)?)+(?!\w|[.,]\d)/g
/** One word of letters and digits (dashes inside: "BW-5821", "1Z999AA1012"). */
const WORD = /(?<![\w.,/:])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\w/:]|[.,]\d)/g

const digitCount = (s: string) => s.replace(/\D/g, '').length
const spaced = (s: string) => [...s.replace(/[^A-Za-z0-9+]/g, '')].join(' ').replace('+ ', 'plus ')

/** Whether a word is read better one character at a time. `before`: the text in front of it. */
function isCode(word: string, before: string): boolean {
  const digits = digitCount(word)
  if (!digits) return false
  const letters = word.replace(/[^A-Za-z]/g, '').length
  if (letters) return digits >= 3 // "BW-5821", "CF115804157DE"; not "10am", "3rd", "2pm"
  if (digits >= 5) return true // a phone number or a long reference; amounts this big are written with separators
  if (word.length >= 2 && word.startsWith('0')) return true // "0176": no amount starts with 0
  return digits >= 3 && CODE_WORDS.test(before) // "order 1038", "Nr. 8252", "#1042"
}

/**
 * The text with its codes spaced out: phone numbers ("0176 80652309", "(503) 555-0142"), long numbers, words of letters
 * and digits, and numbers after a word like "order" or "Nummer". `before`: text already sent in front of `text`.
 */
export function spellCodes(text: string, before = ''): string {
  const phones = text.replace(PHONE, match => (digitCount(match) >= 7 ? spaced(match) : match))
  return phones.replace(WORD, (word, offset: number) =>
    isCode(word, before + phones.slice(0, offset)) ? spaced(word) : word,
  )
}

/** The end of a sentence with a number in it: ".", "!" or "?" and a space, but not the dot of "14. November". */
const SENTENCE_END = /(?<!(?:^|\D)\d{1,2})[.!?…](?=\s)|\n/g

/**
 * spellCodes on the reply as the model streams it. Text without a digit goes on at once, up to its last whole word.
 * From a word with a digit on, the text is held to the end of its sentence, so a code split across chunks
 * ("0176 806" + "52309") is spaced out whole; a sentence without digits loses no time.
 */
export function spellCodesTransform(text: ReadableStream<string>): ReadableStream<string> {
  let pending = ''
  let sent = ''
  const reader = text.getReader()
  const send = (controller: ReadableStreamDefaultController<string>, part: string, spell: boolean) => {
    if (!part) return
    const out = spell ? spellCodes(part, sent.slice(-40)) : part
    sent = (sent + part).slice(-200)
    controller.enqueue(out)
  }
  /** Sends what can go now; false when all of it waits for more text. */
  const flush = (controller: ReadableStreamDefaultController<string>): boolean => {
    let any = false
    for (;;) {
      const digit = pending.search(/\d/)
      if (digit < 0) {
        // Hold the last word: it may still become a code ("CF" + "115…").
        const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n')) + 1
        if (cut > 0) any = true
        send(controller, pending.slice(0, cut), false)
        pending = pending.slice(cut)
        return any
      }
      // The word the digit is in, and the word before it ("Nummer", "order", "+") are held with it.
      const wordStart = pending.slice(0, digit).search(/\S*\s*\S*$/)
      if (wordStart > 0) any = true
      send(controller, pending.slice(0, wordStart), false)
      pending = pending.slice(wordStart)
      SENTENCE_END.lastIndex = 0
      const end = SENTENCE_END.exec(pending)
      if (!end) return any
      const at = end.index + end[0].length
      send(controller, pending.slice(0, at), true)
      pending = pending.slice(at)
      any = true
    }
  }
  return new ReadableStream<string>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          send(controller, pending, true)
          pending = ''
          controller.close()
          return
        }
        pending += value
        if (flush(controller)) return
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
