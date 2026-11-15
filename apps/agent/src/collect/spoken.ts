// What a caller says, turned into what they mean: digits ("five oh three, double five"), spelled
// letters ("B as in Bravo, R, E…", NATO alphabet tolerant) and email addresses ("dana dot ruiz at
// gmail dot com"). Speech recognition writes either words or symbols; both come out the same. Input
// that is already normalized ("5035550142", "dana.ruiz@gmail.com") passes through unchanged.

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  // The other languages calls are answered in, for when speech recognition writes words: Spanish, French, Italian,
  // Portuguese (not "um", an English filler; nor French "un", an article) and German.
  cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
  zéro: '0', deux: '2', trois: '3', quatre: '4', cinq: '5', sept: '7', huit: '8', neuf: '9',
  due: '2', tre: '3', quattro: '4', cinque: '5', sei: '6', sette: '7', otto: '8', nove: '9',
  dois: '2', duas: '2', três: '3', quatro: '4', sete: '7', oito: '8',
  null: '0', eins: '1', zwei: '2', zwo: '2', drei: '3', vier: '4', fünf: '5', fuenf: '5', sechs: '6', sieben: '7',
  acht: '8', neun: '9',
}
/** Korean digits as said in phone numbers (Sino-Korean, 공 or 영 for zero), often written without spaces ("공일공"). */
const KOREAN_DIGITS: Record<string, string> = {
  공: '0', 영: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9',
}
const KOREAN_NUMBER = /^[공영일이삼사오육륙칠팔구]+$/
const TEEN_WORDS: Record<string, string> = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19',
}
const TENS_WORDS: Record<string, string> = {
  twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9',
}
const REPEAT_WORDS: Record<string, number> = { double: 2, triple: 3 }

/** The NATO alphabet and the usual alternatives callers use. */
const PHONETIC: Record<string, string> = {
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', foxtrot: 'f', fox: 'f', golf: 'g',
  hotel: 'h', india: 'i', juliet: 'j', juliett: 'j', kilo: 'k', lima: 'l', mike: 'm', november: 'n',
  oscar: 'o', papa: 'p', quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u', victor: 'v',
  whiskey: 'w', whisky: 'w', xray: 'x', 'x-ray': 'x', yankee: 'y', zulu: 'z',
}
/** How letters sound when spoken alone ("bee", "see", "double-u"). */
const LETTER_NAMES: Record<string, string> = {
  ay: 'a', bee: 'b', be: 'b', see: 'c', cee: 'c', dee: 'd', ee: 'e', ef: 'f', eff: 'f', gee: 'g', aitch: 'h',
  jay: 'j', kay: 'k', el: 'l', ell: 'l', em: 'm', en: 'n', pee: 'p', cue: 'q', queue: 'q', ar: 'r', are: 'r',
  es: 's', ess: 's', tee: 't', you: 'u', vee: 'v', 'double-u': 'w', doubleu: 'w', ex: 'x', why: 'y', zee: 'z', zed: 'z',
}
const SYMBOL_WORDS: Record<string, string> = {
  dash: '-', hyphen: '-', apostrophe: "'", period: '.', dot: '.', underscore: '_', plus: '+',
}
/** Words that carry no digit or letter: "area code five oh three", "um", "it's". */
const FILLER = new Set(['um', 'uh', 'er', 'erm', 'and', 'then', 'area', 'code', 'its', "it's", 'is', 'my', 'number', 'the', 'like', 'so', 'okay', 'ok'])

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/x-ray/g, 'xray')
    .replace(/double-u/g, 'doubleu')
    .split(/[\s,;:!?()]+|(?<=\D)\.(?=\s|$)/)
    .map(w => w.replace(/^[."']+|[."']+$/g, ''))
    .filter(Boolean)

/**
 * The digits in what the caller said, with a leading + when they said "plus" first. Number words and
 * numerals both count; "double five" is 55, "twenty one" 21, "five hundred" 500. Everything else
 * (fillers, "area code", dashes) is skipped.
 */
export function spokenDigits(text: string): string {
  let out = ''
  let repeat = 1
  let tens: string | null = null
  const flushTens = () => {
    if (tens !== null) out += `${tens}0`
    tens = null
  }
  for (const word of words(text)) {
    if (word === 'plus' && !out) {
      out = '+'
      continue
    }
    if (REPEAT_WORDS[word]) {
      flushTens()
      repeat = REPEAT_WORDS[word]!
      continue
    }
    const digit = DIGIT_WORDS[word]
    if (digit !== undefined && tens !== null && digit !== '0') {
      out += tens + digit
      tens = null
      continue
    }
    flushTens()
    if (digit !== undefined) out += digit.repeat(repeat)
    else if (TEEN_WORDS[word]) out += TEEN_WORDS[word]
    else if (TENS_WORDS[word]) tens = TENS_WORDS[word]!
    else if (KOREAN_NUMBER.test(word)) out += [...word].map(ch => KOREAN_DIGITS[ch]).join('')
    else if (word === 'hundred' && out && out !== '+') out += '00'
    else if (word === 'thousand' && out && out !== '+') out += '000'
    else {
      const numerals = word.replace(/[^\d]/g, '')
      if (word.startsWith('+') && !out) out = '+'
      out += repeat > 1 && numerals.length === 1 ? numerals.repeat(repeat) : numerals
    }
    repeat = 1
  }
  flushTens()
  return out === '+' ? '' : out
}

const letterOf = (word: string): string | null => {
  if (/^[a-z]$/.test(word)) return word
  return PHONETIC[word] ?? LETTER_NAMES[word] ?? null
}

/** How many tokens "as in Bravo" / "for Bravo" after a letter take; 0 when there is none. */
const exampleWordsAfter = (tokens: string[], i: number) =>
  tokens[i + 1] === 'as' && tokens[i + 2] === 'in' && tokens[i + 3] ? 3 : tokens[i + 1] === 'for' && tokens[i + 2] ? 2 : 0

/**
 * The letters a caller spelled: single letters, NATO words ("Romeo Uniform India Zulu"), "B as in
 * Bravo", "double n", dashes and apostrophes. Null when the text is not a spelling (fewer than two
 * spelled letters): then it is a word as said ("Ruiz").
 */
export function spokenLetters(text: string): string | null {
  const tokens = words(text)
  let out = ''
  let spelled = 0
  let repeat = 1
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!
    if (REPEAT_WORDS[word]) {
      repeat = REPEAT_WORDS[word]!
      continue
    }
    // "B as in Bravo" / "B for Bravo": the letter, and the example word is skipped.
    const example = exampleWordsAfter(tokens, i)
    if (/^[a-z]$/.test(word) && example) {
      i += example
      out += word.repeat(repeat)
      spelled++
      repeat = 1
      continue
    }
    const letter = letterOf(word)
    if (letter) {
      out += letter.repeat(repeat)
      spelled++
    } else if (SYMBOL_WORDS[word] === '-' || SYMBOL_WORDS[word] === "'") out += SYMBOL_WORDS[word]
    else if (word === 'space') out += ' '
    else if (/^[a-z]+$/.test(word) && word.length > 1 && !FILLER.has(word) && spelled === 0) {
      // "Ruiz, R U I Z": the word said before its spelling is not part of it.
      continue
    }
    repeat = 1
  }
  return spelled >= 2 ? out : null
}

/** "o'brien" → "O'Brien", "mary-jane" → "Mary-Jane". */
export const capitalizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/^(Mc)(\p{L})/u, (_m, mc: string, ch: string) => mc + ch.toUpperCase())

/** Words around an email address that are not part of it ("my email is …", "all lowercase"). */
const SKIP_IN_EMAIL = new Set(['my', 'email', 'address', 'is', 'its', "it's", 'all', 'lowercase', 'um', 'uh'])

/**
 * An email address as said: "dana dot ruiz at gmail dot com", "d a n a underscore r at yahoo dot com",
 * "sam two two at outlook dot com". Letters spelled with "as in" count as letters; other words stay
 * words (so "mike" stays "mike"); number words become digits.
 */
export function spokenEmail(text: string): string {
  const tokens = words(text.replace(/@/g, ' at ').replace(/(\w)\.(\w)/g, '$1 dot $2'))
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!
    if (/^[a-z]$/.test(word) && tokens[i + 1] === 'as' && tokens[i + 2] === 'in') {
      out += word
      i += 3
      continue
    }
    if (word === 'at') out += '@'
    else if (SYMBOL_WORDS[word]) out += SYMBOL_WORDS[word]
    else if (DIGIT_WORDS[word] !== undefined && word !== 'o') out += DIGIT_WORDS[word]
    else if (!SKIP_IN_EMAIL.has(word)) out += word
  }
  return out
}

/** Digits read back one by one in groups, the way people say phone numbers: "5 0 3, 5 5 5, 0 1 4 2". */
export function readDigits(digits: string, groups: number[] = []): string {
  const plain = digits.replace(/\D/g, '')
  const parts: string[] = []
  let at = 0
  for (const size of groups) {
    if (at >= plain.length) break
    parts.push(plain.slice(at, at + size))
    at += size
  }
  if (at < plain.length) parts.push(plain.slice(at))
  return parts.map(p => p.split('').join(' ')).join(', ')
}

const SYMBOL_NAMES: Record<string, string> = { '-': 'dash', "'": 'apostrophe', '.': 'dot', _: 'underscore', '+': 'plus', '@': 'at' }

/** Letters read back one by one: "R, U, I, Z". */
export const readLetters = (word: string) =>
  [...word.replace(/\s+/g, '')]
    .map(ch => SYMBOL_NAMES[ch] ?? ch.toUpperCase())
    .join(', ')
