import { describe, expect, test } from 'vitest'
import { toE164 } from './collectors.ts'
import { spokenDigits, WORDS } from './spoken-digits.ts'

const cases: Record<string, [said: string, digits: string][]> = {
  en: [
    ['five oh three, five five five, oh one four two', '5035550142'],
    ['five hundred and three, five fifty five, oh one forty eight', '5035550148'],
    ['twenty five hundred', '2500'],
    ['Oh, my number is five oh three', '503'],
    ['ten five', '105'],
    ['double oh seven', '007'],
  ],
  // The calls in the demo-language test (fr-1, fr-2): "un" was skipped as an article.
  fr: [
    [
      "C'est bien mon numéro, le cinq zéro trois cinq cinq cinq zéro un quatre cinq. Je voulais aussi savoir quand est-ce que quelqu'un pourrait passer.",
      '5035550145',
    ],
    ['Elle, mon numéro de téléphone est le cinq zéro trois cinq cinq cinq zéro un quatre six.', '5035550146'],
    ['zéro six, douze, trente-quatre, cinquante-six, soixante-dix-huit', '0612345678'],
    ['zéro un, quatre-vingt-dix-neuf, soixante et onze, quatre-vingts, vingt et un', '0199718021'],
    ['zéro quatre, quatre-vingt-un, dix-sept, cent trois', '048117103'],
    ['cinq cent cinquante-cinq', '555'],
    ['septante-sept, nonante', '7790'],
    ["j'ai un numéro: zéro six un deux", '0612'],
  ],
  // pt-2r: "um" was skipped and grouped numbers were not read.
  pt: [
    ['O meu número é quinhentos e três, quinhentos e cinquenta e cinco, zero um quarenta e oito.', '5035550148'],
    [
      'Um código de área é quinhentos e três, e o número é quinhentos e cinquenta e cinco, zero um quarenta e oito.',
      '5035550148',
    ],
    ['onze, nove meia meia, um dois, três quatro', '119661234'],
    ['um um nove oito sete', '11987'],
    ['dezenove, vinte e um, cem, cento e dez', '1921100110'],
  ],
  es: [
    ['seis cero cinco, cincuenta y cinco, doce, treinta y cuatro', '605551234'],
    ['quinientos tres, quinientos cincuenta y cinco, cero uno cuarenta y ocho', '5035550148'],
    ['veintidós, dieciséis, un dos tres', '2216123'],
    ['doble cinco, dos', '552'],
  ],
  de: [
    ['null eins fünf eins, zwei drei vier fünf, sechs sieben acht neun', '015123456789'],
    ['null sieben sechs, einhundertdreiundzwanzig, fünfundvierzig, siebenundsechzig', '0761234567'],
    ['fünfhundertdrei, fünfhundertfünfundfünfzig, null eins achtundvierzig', '5035550148'],
    ['zwo zwo, achtzehn, dreißig', '221830'],
    ['Ein Moment, null eins sieben', '017'],
  ],
  it: [
    ['tre tre otto, uno due tre, quarantacinque sessantasette', '3381234567'],
    ['cinquecentotré, cinquecentocinquantacinque, zero uno quarantotto', '5035550148'],
    ['ventuno, ventitré, centottanta, cento', '2123180100'],
    ['zero sei, sei sette', '0667'],
  ],
  nl: [
    ['nul zes, twaalf, vierendertig, zesenvijftig, achtenzeventig', '0612345678'],
    ['vijfhonderddrie, vijfhonderdvijfenvijftig, nul één achtenveertig', '5035550148'],
    ['nul twintig, een twee drie, vier vijf', '02012345'],
    ['tweeëntwintig, eenentwintig', '2221'],
  ],
  ru: [
    ['восемь девятьсот шестнадцать сто двадцать три сорок пять шестьдесят семь', '89161234567'],
    ['ноль один два три, четыре пять шесть, семь восемь девять', '0123456789'],
    ['пятьсот три, пятьсот пятьдесят пять, ноль один сорок восемь', '5035550148'],
    ['плюс семь девятьсот', '+7900'],
  ],
  uk: [["нуль шістдесят сім, п'ятсот три, дев'яносто дев'ять", '06750399']],
  hi: [
    ['नौ आठ सात छह पांच, चार तीन दो एक शून्य', '9876543210'],
    ['मेरा नंबर पाँच सौ तीन, पचपन, शून्य एक अड़तालीस है', '503550148'],
    ['डबल नौ, अट्ठानवे, इक्कीस', '999821'],
    ['nau aath saat chhah paanch char teen do ek shunya', '9876543210'],
    ['९८७६५ ४३२१०', '9876543210'],
    ['लिख दो', ''],
  ],
  ja: [
    ['〇九〇の一二三四の五六七八です', '09012345678'],
    ['ゼロキューゼロ、イチニーサンヨン、ゴーロクナナハチ', '09012345678'],
    ['０９０－１２３４－５６７８', '09012345678'],
    ['電話番号は 503 のご母の 0150 です。', '5030150'],
    ['五百三、五十五、零一五零', '503550150'],
    ['もう一度言います、零三の一二三四', '031234'],
    ['田中さんです', ''],
  ],
  zh: [['幺三八,一二三四,五六七八', '13812345678']],
  ko: [['공일공 일이삼사 오육칠팔', '01012345678']],
  pl: [['zero sześć, pięć dwa', '0652']],
  tr: [['sıfır beş üç iki, bir iki üç', '0532123']],
  sv: [['noll sju, en två tre', '07123']],
  ar: [
    ['صفر خمسة واحد', '051'],
    ['٠٥٠ ١٢٣', '050123'],
  ],
  el: [['μηδέν έξι ένα', '061']],
  mixed: [
    ['503 cinquante-cinq 01 48', '503550148'],
    ['five oh three, 555, 0142', '5035550142'],
    ['plus forty nine one five one', '+49151'],
    ['+49 151 2345', '+491512345'],
  ],
}

describe('spokenDigits', () => {
  for (const [lang, list] of Object.entries(cases)) {
    test.each(list)(`${lang}: %s`, (said, digits) => {
      expect(spokenDigits(said)).toBe(digits)
    })
  }

  test('nothing to read', () => {
    expect(spokenDigits('um, nothing')).toBe('')
    expect(spokenDigits('Um código de área')).toBe('')
    expect(spokenDigits("J'ai un problème")).toBe('')
    expect(spokenDigits('plus')).toBe('')
  })
})

test('a word that counts in every language means the same digit in all of them', () => {
  for (const [word, entries] of WORDS) {
    const values = new Set(entries.filter(e => !e.weak).map(e => e.value))
    expect(values.size, word).toBeLessThanOrEqual(1)
  }
})

describe('phone numbers from the demo-language test', () => {
  test('French and Portuguese callers now give a whole US number', () => {
    expect(toE164('le cinq zéro trois cinq cinq cinq zéro un quatre cinq')).toEqual({ ok: true, value: '+15035550145' })
    expect(toE164('quinhentos e três, quinhentos e cinquenta e cinco, zero um quarenta e oito')).toEqual({
      ok: true,
      value: '+15035550148',
    })
  })

  test('a national number in the business country', () => {
    expect(toE164('zéro six, douze, trente-quatre, cinquante-six, soixante-dix-huit', 'FR')).toEqual({
      ok: true,
      value: '+33612345678',
    })
    expect(toE164('null eins fünf eins, zwei drei vier fünf, sechs sieben acht neun', 'DE')).toEqual({
      ok: true,
      value: '+4915123456789',
    })
    expect(toE164('〇九〇の一二三四の五六七八', 'JP')).toEqual({ ok: true, value: '+819012345678' })
  })
})
