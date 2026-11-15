/**
 * The pseudo-locale en-XA (development and staging only): every English message with accented letters, about 35%
 * longer and wrapped in ⟦ ⟧. Text that shows without the brackets is not translated yet; a layout that breaks with
 * it breaks with German or French too. Built at runtime from the English catalog; it has no files.
 */
import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser'

const PLAIN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ACCENTED = 'áƀçðéƒĝĥíĵķļɱñóþǫŕšţúṽŵẋýžÁƁÇÐÉƑĜĤÍĴĶĻṀÑÓÞǪŔŠŢÚṼŴẊÝŽ'
const ACCENTS: Record<string, string> = Object.fromEntries(
  [...PLAIN].map((char, i) => [char, [...ACCENTED][i] ?? char]),
)

/** Accents every letter and pads the text by about 35% (vowels doubled). */
export function pseudoText(text: string): string {
  let out = ''
  let vowels = 0
  for (const char of text) {
    out += ACCENTS[char] ?? char
    if ('aeiouAEIOU'.includes(char) && vowels++ % 2 === 0) out += ACCENTS[char] ?? char
  }
  return out
}

function transform(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.map(element => {
    switch (element.type) {
      case TYPE.literal:
        return { ...element, value: pseudoText(element.value) }
      case TYPE.plural:
      case TYPE.select:
        return {
          ...element,
          options: Object.fromEntries(
            Object.entries(element.options).map(([key, option]) => [
              key,
              { ...option, value: transform(option.value) },
            ]),
          ),
        }
      case TYPE.tag:
        return { ...element, children: transform(element.children) }
      default:
        return element
    }
  })
}

/** One message in en-XA, parsed (FormatJS takes the parsed form as a message). Arguments and tags stay as they are. */
export function pseudoMessage(message: string): MessageFormatElement[] {
  const parsed = transform(parse(message))
  return [{ type: TYPE.literal, value: '⟦' }, ...parsed, { type: TYPE.literal, value: '⟧' }]
}

/** The whole en-XA catalog from the English one. */
export function pseudoMessages(en: Record<string, string>): Record<string, MessageFormatElement[]> {
  return Object.fromEntries(Object.entries(en).map(([key, message]) => [key, pseudoMessage(message)]))
}
