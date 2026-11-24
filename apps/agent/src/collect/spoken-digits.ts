// Digits as callers say them, in every language an assistant speaks (packages/actions languages.ts): one by one
// ("cinq zéro trois", "ноль один"), in groups ("quinhentos e três", "cinquante-cinq", "fünfundfünfzig", "五十五"),
// with "double five", or as numerals. Speech recognition writes words in some turns and numerals in others, and
// numerals in any script (०१२, ٠١٢, ０１２); all of it comes out as ASCII digits.
//
// The call's language is not passed in, so the words decide it: the language with the most number words in the
// text wins, and its words count. Words that are also everyday words ("um" is 1 in Portuguese and a filler in
// English, French "un" is also "a", Danish "to" is 2 and English "to") count only in their language and only next to
// other digits: "zero um quarenta" has a 1, "Um código de área" has none.

type NumberWord = {
  value: number
  /** Multiplies what was said since the last multiplier: "five hundred", "twenty five hundred", 五十, "पांच सौ". */
  times?: boolean
  /** Also an everyday word: counts only in its language, next to other digits. */
  weak?: boolean
  /** Takes nothing after it: English "ten five" is 105 (French "dix-sept" is 17, Hindi "पचास" is 50 on its own). */
  closed?: boolean
  /** French soixante and quatre-vingt take dix to dix-neuf: soixante-dix-sept is 77, quatre-vingt-onze 91. */
  takesTeen?: boolean
  /** French "vingt" right after "quatre" makes 80. */
  score?: boolean
}
type Entry = NumberWord & { lang: string }

/**
 * Number words per language, by value. A word ending in ~ is weak (also an everyday word); one starting with * is a
 * multiplier. Words that are written as one with others (German "fünfundfünfzig", Dutch "vijfenvijftig", Italian
 * "cinquantacinque") are split by COMPOUND_PARTS, Japanese and Chinese by cjkItems, Korean by KOREAN_DIGITS. The
 * order of the languages breaks ties.
 */
const LEXICON: Record<string, Record<number, string>> = {
  en: {
    0: 'zero nought oh~ o~', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
    9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen',
    17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty',
    60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety', 100: '*hundred', 1000: '*thousand',
  },
  es: {
    0: 'cero', 1: 'uno un~ una~', 2: 'dos~', 3: 'tres', 4: 'cuatro', 5: 'cinco', 6: 'seis', 7: 'siete', 8: 'ocho',
    9: 'nueve', 10: 'diez', 11: 'once~', 12: 'doce', 13: 'trece', 14: 'catorce', 15: 'quince',
    16: 'dieciséis dieciseis', 17: 'diecisiete', 18: 'dieciocho', 19: 'diecinueve', 20: 'veinte',
    21: 'veintiuno veintiún veintiuna', 22: 'veintidós veintidos', 23: 'veintitrés veintitres', 24: 'veinticuatro',
    25: 'veinticinco', 26: 'veintiséis veintiseis', 27: 'veintisiete', 28: 'veintiocho', 29: 'veintinueve',
    30: 'treinta', 40: 'cuarenta', 50: 'cincuenta', 60: 'sesenta', 70: 'setenta', 80: 'ochenta', 90: 'noventa',
    100: 'cien ciento', 200: 'doscientos doscientas', 300: 'trescientos trescientas',
    400: 'cuatrocientos cuatrocientas', 500: 'quinientos quinientas', 600: 'seiscientos seiscientas',
    700: 'setecientos setecientas', 800: 'ochocientos ochocientas', 900: 'novecientos novecientas', 1000: '*mil',
  },
  fr: {
    0: 'zéro zero', 1: 'un~ une~', 2: 'deux', 3: 'trois', 4: 'quatre', 5: 'cinq', 6: 'six', 7: 'sept', 8: 'huit',
    9: 'neuf', 10: 'dix', 11: 'onze', 12: 'douze', 13: 'treize', 14: 'quatorze', 15: 'quinze', 16: 'seize',
    20: 'vingt vingts', 30: 'trente', 40: 'quarante', 50: 'cinquante', 60: 'soixante', 70: 'septante',
    80: 'huitante octante', 90: 'nonante', 100: '*cent *cents', 1000: '*mille',
  },
  de: {
    0: 'null', 1: 'eins ein~ eine~', 2: 'zwei zwo', 3: 'drei', 4: 'vier', 5: 'fünf fuenf', 6: 'sechs', 7: 'sieben',
    8: 'acht', 9: 'neun', 10: 'zehn', 11: 'elf', 12: 'zwölf zwoelf', 13: 'dreizehn', 14: 'vierzehn',
    15: 'fünfzehn fuenfzehn', 16: 'sechzehn', 17: 'siebzehn', 18: 'achtzehn', 19: 'neunzehn', 20: 'zwanzig',
    30: 'dreißig dreissig', 40: 'vierzig', 50: 'fünfzig fuenfzig', 60: 'sechzig', 70: 'siebzig', 80: 'achtzig',
    90: 'neunzig', 100: '*hundert', 1000: '*tausend',
  },
  it: {
    0: 'zero', 1: 'uno un~ una~', 2: 'due', 3: 'tre tré', 4: 'quattro', 5: 'cinque', 6: 'sei~', 7: 'sette', 8: 'otto',
    9: 'nove', 10: 'dieci', 11: 'undici', 12: 'dodici', 13: 'tredici', 14: 'quattordici', 15: 'quindici',
    16: 'sedici', 17: 'diciassette', 18: 'diciotto', 19: 'diciannove', 20: 'venti', 30: 'trenta', 40: 'quaranta',
    50: 'cinquanta', 60: 'sessanta', 70: 'settanta', 80: 'ottanta', 90: 'novanta', 100: 'cento', 1000: 'mille *mila',
  },
  pt: {
    0: 'zero', 1: 'um~ uma~', 2: 'dois duas', 3: 'três tres', 4: 'quatro', 5: 'cinco', 6: 'seis meia~', 7: 'sete',
    8: 'oito', 9: 'nove', 10: 'dez', 11: 'onze', 12: 'doze', 13: 'treze', 14: 'catorze quatorze', 15: 'quinze',
    16: 'dezesseis dezasseis', 17: 'dezessete dezassete', 18: 'dezoito', 19: 'dezenove dezanove', 20: 'vinte',
    30: 'trinta', 40: 'quarenta', 50: 'cinquenta cinqüenta', 60: 'sessenta', 70: 'setenta', 80: 'oitenta',
    90: 'noventa', 100: 'cem cento', 200: 'duzentos duzentas', 300: 'trezentos trezentas',
    400: 'quatrocentos quatrocentas', 500: 'quinhentos quinhentas', 600: 'seiscentos seiscentas',
    700: 'setecentos setecentas', 800: 'oitocentos oitocentas', 900: 'novecentos novecentas', 1000: '*mil',
  },
  nl: {
    0: 'nul~', 1: 'één eén een~', 2: 'twee', 3: 'drie', 4: 'vier', 5: 'vijf', 6: 'zes', 7: 'zeven', 8: 'acht',
    9: 'negen', 10: 'tien', 11: 'elf', 12: 'twaalf', 13: 'dertien', 14: 'veertien', 15: 'vijftien', 16: 'zestien',
    17: 'zeventien', 18: 'achttien', 19: 'negentien', 20: 'twintig', 30: 'dertig', 40: 'veertig', 50: 'vijftig',
    60: 'zestig', 70: 'zeventig', 80: 'tachtig', 90: 'negentig', 100: '*honderd', 1000: '*duizend',
  },
  ru: {
    0: 'ноль нуль', 1: 'один одна~ одно~', 2: 'два две', 3: 'три', 4: 'четыре', 5: 'пять', 6: 'шесть', 7: 'семь',
    8: 'восемь', 9: 'девять', 10: 'десять', 11: 'одиннадцать', 12: 'двенадцать', 13: 'тринадцать',
    14: 'четырнадцать', 15: 'пятнадцать', 16: 'шестнадцать', 17: 'семнадцать', 18: 'восемнадцать',
    19: 'девятнадцать', 20: 'двадцать', 30: 'тридцать', 40: 'сорок', 50: 'пятьдесят', 60: 'шестьдесят',
    70: 'семьдесят', 80: 'восемьдесят', 90: 'девяносто', 100: 'сто', 200: 'двести', 300: 'триста',
    400: 'четыреста', 500: 'пятьсот', 600: 'шестьсот', 700: 'семьсот', 800: 'восемьсот', 900: 'девятьсот',
    1000: '*тысяча *тысячи *тысяч',
  },
  uk: {
    0: 'нуль ноль', 1: 'один одна~ одне~', 2: 'два дві', 3: 'три', 4: 'чотири', 5: "п'ять", 6: 'шість', 7: 'сім',
    8: 'вісім', 9: "дев'ять", 10: 'десять', 11: 'одинадцять', 12: 'дванадцять', 13: 'тринадцять',
    14: 'чотирнадцять', 15: "п'ятнадцять", 16: 'шістнадцять', 17: 'сімнадцять', 18: 'вісімнадцять',
    19: "дев'ятнадцять", 20: 'двадцять', 30: 'тридцять', 40: 'сорок', 50: "п'ятдесят", 60: 'шістдесят',
    70: 'сімдесят', 80: 'вісімдесят', 90: "дев'яносто", 100: 'сто', 200: 'двісті', 300: 'триста',
    400: 'чотириста', 500: "п'ятсот", 600: 'шістсот', 700: 'сімсот', 800: 'вісімсот', 900: "дев'ятсот",
    1000: '*тисяча *тисячі *тисяч',
  },
  // Hindi: every number to 99 has its own word. Also the Latin spelling speech recognition sometimes writes.
  hi: {
    0: 'शून्य जीरो shunya shoonya sunya', 1: 'एक~ ek~', 2: 'दो~ do~', 3: 'तीन teen~ tin~', 4: 'चार char~ chaar',
    5: 'पांच paanch panch', 6: 'छह छः छे छै chhah chhe chah~', 7: 'सात saat~', 8: 'आठ aath', 9: 'नौ nau~',
    10: 'दस das~', 11: 'ग्यारह', 12: 'बारह', 13: 'तेरह', 14: 'चौदह', 15: 'पंद्रह पन्द्रह', 16: 'सोलह', 17: 'सत्रह',
    18: 'अठारह', 19: 'उन्नीस', 20: 'बीस', 21: 'इक्कीस', 22: 'बाईस', 23: 'तेईस', 24: 'चौबीस', 25: 'पच्चीस',
    26: 'छब्बीस', 27: 'सत्ताईस', 28: 'अट्ठाईस', 29: 'उनतीस', 30: 'तीस', 31: 'इकतीस', 32: 'बत्तीस', 33: 'तैंतीस',
    34: 'चौंतीस', 35: 'पैंतीस', 36: 'छत्तीस', 37: 'सैंतीस', 38: 'अड़तीस', 39: 'उनतालीस', 40: 'चालीस',
    41: 'इकतालीस', 42: 'बयालीस', 43: 'तैंतालीस', 44: 'चवालीस चौवालीस', 45: 'पैंतालीस', 46: 'छियालीस',
    47: 'सैंतालीस', 48: 'अड़तालीस', 49: 'उनचास', 50: 'पचास', 51: 'इक्यावन', 52: 'बावन', 53: 'तिरपन तिरेपन',
    54: 'चौवन', 55: 'पचपन', 56: 'छप्पन', 57: 'सत्तावन', 58: 'अट्ठावन', 59: 'उनसठ', 60: 'साठ', 61: 'इकसठ',
    62: 'बासठ', 63: 'तिरसठ', 64: 'चौंसठ', 65: 'पैंसठ', 66: 'छियासठ', 67: 'सड़सठ सरसठ', 68: 'अड़सठ', 69: 'उनहत्तर',
    70: 'सत्तर', 71: 'इकहत्तर', 72: 'बहत्तर', 73: 'तिहत्तर', 74: 'चौहत्तर', 75: 'पचहत्तर', 76: 'छिहत्तर',
    77: 'सतहत्तर', 78: 'अठहत्तर', 79: 'उन्यासी उनासी', 80: 'अस्सी', 81: 'इक्यासी', 82: 'बयासी', 83: 'तिरासी',
    84: 'चौरासी', 85: 'पचासी', 86: 'छियासी', 87: 'सत्तासी', 88: 'अट्ठासी', 89: 'नवासी', 90: 'नब्बे', 91: 'इक्यानवे',
    92: 'बानवे', 93: 'तिरानवे', 94: 'चौरानवे', 95: 'पचानवे', 96: 'छियानवे', 97: 'सत्तानवे', 98: 'अट्ठानवे',
    99: 'निन्यानवे', 100: '*सौ *sau~', 1000: '*हज़ार *हजार',
  },
  // The languages speech recognition only gets from Nova-3: single digits (pl … el), Arabic also as words.
  pl: {
    0: 'zero', 1: 'jeden jedna~', 2: 'dwa dwie', 3: 'trzy', 4: 'cztery', 5: 'pięć', 6: 'sześć', 7: 'siedem',
    8: 'osiem', 9: 'dziewięć',
  },
  tr: { 0: 'sıfır', 1: 'bir~', 2: 'iki', 3: 'üç', 4: 'dört', 5: 'beş', 6: 'altı~', 7: 'yedi', 8: 'sekiz', 9: 'dokuz' },
  vi: {
    0: 'không~', 1: 'một~', 2: 'hai~', 3: 'ba~', 4: 'bốn~ tư~', 5: 'năm~ lăm~', 6: 'sáu~', 7: 'bảy~', 8: 'tám~',
    9: 'chín~',
  },
  id: {
    0: 'nol kosong~', 1: 'satu', 2: 'dua', 3: 'tiga', 4: 'empat', 5: 'lima~', 6: 'enam', 7: 'tujuh', 8: 'delapan',
    9: 'sembilan',
  },
  sv: { 0: 'noll', 1: 'ett~ en~', 2: 'två', 3: 'tre', 4: 'fyra', 5: 'fem', 6: 'sex~', 7: 'sju', 8: 'åtta', 9: 'nio' },
  da: { 0: 'nul~', 1: 'en~ et~', 2: 'to~', 3: 'tre', 4: 'fire~', 5: 'fem', 6: 'seks', 7: 'syv', 8: 'otte', 9: 'ni~' },
  no: {
    0: 'null', 1: 'en~ ett~', 2: 'to~', 3: 'tre', 4: 'fire~', 5: 'fem', 6: 'seks', 7: 'sju syv', 8: 'åtte', 9: 'ni~',
  },
  fi: {
    0: 'nolla', 1: 'yksi', 2: 'kaksi', 3: 'kolme', 4: 'neljä', 5: 'viisi', 6: 'kuusi~', 7: 'seitsemän',
    8: 'kahdeksan', 9: 'yhdeksän',
  },
  hu: {
    0: 'nulla~', 1: 'egy~', 2: 'kettő két~', 3: 'három', 4: 'négy', 5: 'öt', 6: 'hat~', 7: 'hét~', 8: 'nyolc',
    9: 'kilenc',
  },
  cs: {
    0: 'nula', 1: 'jedna~ jeden', 2: 'dva dvě', 3: 'tři', 4: 'čtyři', 5: 'pět', 6: 'šest', 7: 'sedm', 8: 'osm',
    9: 'devět',
  },
  ro: {
    0: 'zero', 1: 'unu una~', 2: 'doi două~', 3: 'trei', 4: 'patru', 5: 'cinci', 6: 'șase şase', 7: 'șapte şapte',
    8: 'opt~', 9: 'nouă',
  },
  el: {
    0: 'μηδέν', 1: 'ένα~ μία~ μια~', 2: 'δύο δυο', 3: 'τρία', 4: 'τέσσερα τέσσερις', 5: 'πέντε', 6: 'έξι',
    7: 'επτά εφτά', 8: 'οκτώ οχτώ', 9: 'εννέα εννιά',
  },
  ar: {
    0: 'صفر', 1: 'واحد', 2: 'اثنان اثنين اتنين', 3: 'ثلاثة ثلاث تلاتة', 4: 'أربعة اربعة أربع اربع', 5: 'خمسة خمس',
    6: 'ستة ست~', 7: 'سبعة سبع', 8: 'ثمانية ثمان تمانية', 9: 'تسعة تسع',
  },
}

/** Parts of number words written as one word: "fünfhundertdreiundzwanzig", "vijfenvijftig", "cinquecentotré". */
const COMPOUND_PARTS: Record<string, Record<number | 'and', string>> = {
  de: {
    and: 'und', 1: 'ein eins', 2: 'zwei zwo', 3: 'drei', 4: 'vier', 5: 'fünf fuenf', 6: 'sechs', 7: 'sieben',
    8: 'acht', 9: 'neun', 10: 'zehn', 11: 'elf', 12: 'zwölf zwoelf', 13: 'dreizehn', 14: 'vierzehn',
    15: 'fünfzehn fuenfzehn', 16: 'sechzehn', 17: 'siebzehn', 18: 'achtzehn', 19: 'neunzehn', 20: 'zwanzig',
    30: 'dreißig dreissig', 40: 'vierzig', 50: 'fünfzig fuenfzig', 60: 'sechzig', 70: 'siebzig', 80: 'achtzig',
    90: 'neunzig', 100: '*hundert', 1000: '*tausend',
  },
  nl: {
    and: 'en ën', 1: 'een één eén', 2: 'twee', 3: 'drie', 4: 'vier', 5: 'vijf', 6: 'zes', 7: 'zeven', 8: 'acht',
    9: 'negen', 10: 'tien', 11: 'elf', 12: 'twaalf', 13: 'dertien', 14: 'veertien', 15: 'vijftien', 16: 'zestien',
    17: 'zeventien', 18: 'achttien', 19: 'negentien', 20: 'twintig', 30: 'dertig', 40: 'veertig', 50: 'vijftig',
    60: 'zestig', 70: 'zeventig', 80: 'tachtig', 90: 'negentig', 100: '*honderd', 1000: '*duizend',
  },
  // Italian drops the vowel before uno and otto: ventuno, quarantotto, centottanta.
  it: {
    and: '', 1: 'uno', 2: 'due', 3: 'tre tré', 4: 'quattro', 5: 'cinque', 6: 'sei', 7: 'sette', 8: 'otto', 9: 'nove',
    10: 'dieci', 11: 'undici', 12: 'dodici', 13: 'tredici', 14: 'quattordici', 15: 'quindici', 16: 'sedici',
    17: 'diciassette', 18: 'diciotto', 19: 'diciannove', 20: 'venti vent', 30: 'trenta trent', 40: 'quaranta quarant',
    50: 'cinquanta cinquant', 60: 'sessanta sessant', 70: 'settanta settant', 80: 'ottanta ottant',
    90: 'novanta novant', 100: '*cento *cent', 1000: '*mille *mila',
  },
}

/** Words that join the parts of a number: "cinquenta e cinco", "cincuenta y cinco", "vingt et un", "five hundred and three". */
const CONNECTORS = new Set(['and', 'y', 'et', 'und', 'e', 'en', 'и', 'і'])
/** "double five" is 55. */
const REPEAT_WORDS: Record<string, number> = {
  double: 2, triple: 3, doble: 2, doppio: 2, doppia: 2, triplo: 3, tripla: 3, duplo: 2, dupla: 2, doppel: 2,
  doppelt: 2, dubbel: 2, dubbele: 2, डबल: 2, ट्रिपल: 3,
}
/** "plus" before the number: a country code follows. */
const PLUS_WORDS = new Set(['plus', 'плюс', 'प्लस'])
/** Korean digits as said in phone numbers (Sino-Korean, 공 or 영 for zero), often written without spaces ("공일공"). */
const KOREAN_DIGITS: Record<string, string> = {
  공: '0', 영: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9',
}
const KOREAN_NUMBER = /^[공영일이삼사오육륙칠팔구]+$/
/** Japanese and Chinese digits (also the forms on forms and banknotes, and Chinese 幺 and 两 as said in phone numbers). */
const CJK_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 壱: 1, 幺: 1, 二: 2, 弐: 2, 两: 2, 兩: 2, 三: 3, 参: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CJK_TIMES: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 千: 1000 }
/** Japanese digit readings (in hiragana; katakana is folded to it), with the long vowels of phone numbers ("ゼロキューゼロ"). */
const KANA_READINGS: Record<string, NumberWord> = {
  ぜろ: { value: 0 }, れい: { value: 0 }, まる: { value: 0 }, いち: { value: 1 }, に: { value: 2 }, にー: { value: 2 },
  にい: { value: 2 }, さん: { value: 3 }, よん: { value: 4 }, し: { value: 4 }, しー: { value: 4 }, ご: { value: 5 },
  ごー: { value: 5 }, ごお: { value: 5 }, ろく: { value: 6 }, なな: { value: 7 }, しち: { value: 7 }, はち: { value: 8 },
  きゅう: { value: 9 }, きゅー: { value: 9 }, く: { value: 9 }, じゅう: { value: 10, times: true },
  じゅー: { value: 10, times: true }, ひゃく: { value: 100, times: true },
}
const KANA_BY_LENGTH = Object.keys(KANA_READINGS).sort((a, b) => b.length - a.length)

const stripAccents = (word: string) => word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
/**
 * One spelling however speech recognition wrote it: NFKC (full-width digits), lower case, one apostrophe, Hindi nukta
 * and chandrabindu folded.
 */
const fold = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’ʼ`]/g, "'")
    .replace(/\u093c/g, '')
    .replace(/\u0901/g, '\u0902')
/** Arabic-Indic, Persian, Devanagari and Bengali numerals as ASCII digits. */
const asciiDigits = (text: string) =>
  text.replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\u09e6-\u09ef]/g, ch => {
    const code = ch.codePointAt(0)!
    const zero = code >= 0x9e6 ? 0x9e6 : code >= 0x966 ? 0x966 : code >= 0x6f0 ? 0x6f0 : 0x660
    return String(code - zero)
  })

/** Every spelling → the languages it is a number word in. Exported for the tests. */
export const WORDS = new Map<string, Entry[]>()
const LANGUAGE_ORDER = Object.keys(LEXICON)

function addWord(word: string, entry: Entry) {
  const list = WORDS.get(word) ?? []
  if (!list.some(e => e.lang === entry.lang)) list.push(entry)
  WORDS.set(word, list)
}

for (const [lang, table] of Object.entries(LEXICON)) {
  for (const [key, spellings] of Object.entries(table)) {
    const value = Number(key)
    for (const raw of spellings.split(' ')) {
      const word = fold(raw.replace(/^\*|~$/g, ''))
      const entry: Entry = { lang, value }
      if (raw.startsWith('*')) entry.times = true
      if (raw.endsWith('~')) entry.weak = true
      // A ten takes no unit after it, except French dix (dix-sept); Hindi tens neither (every number has its word).
      if ((value === 10 && lang !== 'fr') || (lang === 'hi' && value % 10 === 0 && value < 100)) entry.closed = true
      if (lang === 'fr' && value === 60) entry.takesTeen = true
      if (lang === 'fr' && value === 20) entry.score = true
      addWord(word, entry)
    }
  }
}
// Without accents ("tres", "zero", "funf"): only in the word's language, and only next to other digits.
for (const [word, entries] of [...WORDS]) {
  const plain = stripAccents(word)
  if (plain === word) continue
  for (const entry of entries) {
    if (!WORDS.get(plain)?.some(e => e.lang === entry.lang)) addWord(plain, { ...entry, weak: true })
  }
}

type Part = { value: number; times?: boolean } | 'and'
const COMPOUNDS: Record<string, { parts: Map<string, Part>; byLength: string[] }> = {}
for (const [lang, table] of Object.entries(COMPOUND_PARTS)) {
  const parts = new Map<string, Part>()
  for (const [key, spellings] of Object.entries(table)) {
    for (const raw of spellings.split(' ').filter(Boolean)) {
      const word = fold(raw.replace(/^\*/, ''))
      const value = Number(key)
      parts.set(word, key === 'and' ? 'and' : raw.startsWith('*') ? { value, times: true } : { value })
    }
  }
  COMPOUNDS[lang] = { parts, byLength: [...parts.keys()].sort((a, b) => b.length - a.length) }
}

/** `word` cut into the given pieces, longest first, or null. */
function cut(word: string, pieces: string[]): string[] | null {
  if (!word) return []
  for (const piece of pieces) {
    if (!word.startsWith(piece)) continue
    const rest = cut(word.slice(piece.length), pieces)
    if (rest) return [piece, ...rest]
  }
  return null
}

/** The value of a number written as one word, from its parts; a unit before "und"/"en" goes after the ten (fünfundfünfzig). */
function compoundValue(parts: Part[]): number | null {
  let total = 0
  let chunk = 0
  let unit: number | null = null
  let and = false
  for (const part of parts) {
    if (part === 'and') {
      if (unit === null || and) return null
      and = true
    } else if (part.times) {
      if (and) return null
      const said = chunk + (unit ?? 0) || 1
      if (part.value === 100) {
        if (said >= 10) return null
        total += said * 100
      } else total = (total + said) * 1000
      chunk = 0
      unit = null
    } else if (part.value < 10) {
      if (unit !== null) return null
      unit = part.value
    } else {
      if (chunk !== 0) return null
      if (and) {
        chunk = part.value + unit!
        unit = null
        and = false
      } else {
        if (unit !== null) return null
        chunk = part.value
      }
    }
  }
  return and ? null : total + chunk + (unit ?? 0)
}

/** A number written as one word ("fünfundfünfzig"), in the languages that write them so. */
function compoundEntries(word: string): Entry[] {
  const entries: Entry[] = []
  for (const [lang, { parts, byLength }] of Object.entries(COMPOUNDS)) {
    const pieces = word.length <= 60 ? cut(word, byLength) : null
    if (!pieces || pieces.length < 2) continue
    const value = compoundValue(pieces.map(p => parts.get(p)!))
    if (value !== null) entries.push({ lang, value })
  }
  return entries
}

type Break = 'none' | 'soft' | 'hard'
type Item =
  | { kind: 'number'; entries: Entry[]; word: string; brk: Break }
  | { kind: 'numerals'; digits: string; plus: boolean; brk: Break }
  | { kind: 'repeat'; times: number; brk: Break }
  | { kind: 'plus'; brk: Break }
  | { kind: 'and'; brk: Break }
  | { kind: 'other'; brk: Break }

const isHan = (ch: string) => /\p{Script=Han}/u.test(ch)
const isKana = (ch: string) => /[\u3041-\u3096\u30a1-\u30fa\u30fc]/.test(ch) && ch !== 'の' && ch !== 'ノ'
const hiragana = (text: string) =>
  text.replace(/[\u30a1-\u30f6]/g, ch => String.fromCodePoint(ch.codePointAt(0)! - 0x60))
const cjkEntries = (word: NumberWord, weak = false): Entry[] =>
  ['ja', 'zh'].map(lang => ({ ...word, lang, ...(weak ? { weak } : {}) }))

/**
 * A word of Japanese or Chinese text (no spaces) as items: numerals, kanji digits ("〇九〇", "五十五"), digit readings
 * in kana ("ゼロキューゼロ"); the rest ("電話番号は", "の") separates. A kanji digit alone next to other kanji is part of a
 * word ("一度", "十分") and does not count; a kana reading alone counts only next to other digits ("さん" is also "Mr").
 */
function cjkItems(word: string, brk: Break): Item[] {
  const items: Item[] = []
  const push = (item: Item) => items.push(items.length ? item : { ...item, brk })
  const chars = [...word]
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]!
    if (/\d/.test(ch)) {
      let digits = ''
      while (i < chars.length && /\d/.test(chars[i]!)) digits += chars[i++]
      push({ kind: 'numerals', digits, plus: false, brk: 'none' })
    } else if (ch in CJK_DIGITS || ch in CJK_TIMES) {
      const start = i
      while (i < chars.length && (chars[i]! in CJK_DIGITS || chars[i]! in CJK_TIMES)) i++
      const run = chars.slice(start, i)
      const inWord = run.length === 1 && [chars[start - 1], chars[i]].some(c => c !== undefined && isHan(c))
      if (inWord) push({ kind: 'other', brk: 'none' })
      else {
        for (const c of run) {
          const word: NumberWord = c in CJK_DIGITS ? { value: CJK_DIGITS[c]! } : { value: CJK_TIMES[c]!, times: true }
          push({ kind: 'number', entries: cjkEntries(word), word: c, brk: 'none' })
        }
      }
    } else if (isKana(ch)) {
      const start = i
      while (i < chars.length && isKana(chars[i]!)) i++
      const readings = cut(hiragana(chars.slice(start, i).join('')), KANA_BY_LENGTH)
      if (readings?.length) {
        const weak = readings.length === 1
        for (const r of readings) {
          push({ kind: 'number', entries: cjkEntries(KANA_READINGS[r]!, weak), word: r, brk: 'none' })
        }
      } else push({ kind: 'other', brk: 'none' })
    } else {
      const isDigitOrKana = (c: string) => /\d/.test(c) || c in CJK_DIGITS || c in CJK_TIMES || isKana(c)
      while (i < chars.length && !isDigitOrKana(chars[i]!)) i++
      push({ kind: 'other', brk: 'none' })
    }
  }
  return items
}

/** The words of a text with the pauses between them: a comma is a soft break, the end of a sentence a hard one. */
function tokens(text: string): { word: string; brk: Break }[] {
  const out: { word: string; brk: Break }[] = []
  let brk: Break = 'none'
  const prepared = asciiDigits(fold(text)).replace(/(?<=\p{L})-(?=\p{L})/gu, ' ')
  for (const piece of prepared.split(/(\s+|[,;:!?()、，；：。！？（）\u2013\u2014]+|(?<=\D)\.(?=\s|$))/u)) {
    if (!piece || /^\s+$/.test(piece)) continue
    if (/^[,;:!?()、，；：。！？（）\u2013\u2014.]+$/.test(piece)) {
      if (/[.!?。！？]/.test(piece)) brk = 'hard'
      else if (brk === 'none') brk = 'soft'
      continue
    }
    const word = piece.replace(/^['"«»“”„]+|['"«»“”„.]+$/g, '')
    if (!word) continue
    out.push({ word, brk })
    brk = 'none'
  }
  return out
}

function items(text: string): Item[] {
  const out: Item[] = []
  for (const { word, brk } of tokens(text)) {
    const known = WORDS.get(word) ?? WORDS.get(stripAccents(word))
    if (PLUS_WORDS.has(word)) out.push({ kind: 'plus', brk })
    else if (REPEAT_WORDS[word]) out.push({ kind: 'repeat', times: REPEAT_WORDS[word], brk })
    else if (known) out.push({ kind: 'number', entries: known, word, brk })
    else if (KOREAN_NUMBER.test(word)) {
      out.push({ kind: 'numerals', digits: [...word].map(ch => KOREAN_DIGITS[ch]).join(''), plus: false, brk })
    } else if (/[\p{Script=Han}\u3041-\u3096\u30a1-\u30fa\u30fc]/u.test(word)) out.push(...cjkItems(word, brk))
    else if (CONNECTORS.has(word)) out.push({ kind: 'and', brk })
    else {
      const compound = /^\p{L}+$/u.test(word) ? compoundEntries(word) : []
      const digits = word.replace(/\D/g, '')
      if (compound.length) out.push({ kind: 'number', entries: compound, word, brk })
      else if (digits) out.push({ kind: 'numerals', digits, plus: word.startsWith('+'), brk })
      else out.push({ kind: 'other', brk })
    }
  }
  return out
}

/** The language with the most number words (an everyday word counts half); ties go to the first in LEXICON (then Japanese, Chinese). */
function languageOf(list: Item[]): string | null {
  const score = new Map<string, number>()
  for (const item of list) {
    if (item.kind !== 'number') continue
    for (const e of item.entries) score.set(e.lang, (score.get(e.lang) ?? 0) + (e.weak ? 0.5 : 1))
  }
  let best: string | null = null
  for (const lang of [...LANGUAGE_ORDER, 'ja', 'zh']) {
    if ((score.get(lang) ?? 0) > (best ? score.get(best)! : 0)) best = lang
  }
  return best
}

type Resolved = { item: Item; word: Entry | null; weak: boolean; counted: boolean }

/**
 * Which items are digits: number words of the text's language, and strong number words of any language (a caller
 * may mix in English digits); weak words only next to a counted digit, looking back across a comma but not ahead.
 */
function resolve(list: Item[]): Resolved[] {
  const lang = languageOf(list)
  const resolved: Resolved[] = list.map(item => {
    if (item.kind !== 'number') return { item, word: null, weak: false, counted: item.kind === 'numerals' }
    const word = item.entries.find(e => e.lang === lang) ?? item.entries.find(e => !e.weak) ?? null
    return { item, word, weak: !!word?.weak, counted: !!word && !word.weak }
  })
  const neighbourCounts = (i: number) => {
    for (let j = i; j > 0; j--) {
      if (resolved[j]!.item.brk === 'hard') break
      const before = resolved[j - 1]!
      if (isGlue(before)) continue
      if (before.counted) return true
      break
    }
    for (let j = i + 1; j < resolved.length; j++) {
      const after = resolved[j]!
      if (after.item.brk !== 'none') break
      if (isGlue(after)) continue
      return after.counted
    }
    return false
  }
  let changed = true
  while (changed) {
    changed = false
    resolved.forEach((r, i) => {
      if (r.weak && !r.counted && neighbourCounts(i)) {
        r.counted = true
        changed = true
      }
    })
  }
  return resolved
}

/**
 * Words between the parts of a number: connectors ("e", "y", "und"), "double", and a number word that does not count
 * here but joins numbers ("et" is Danish 1 and French "and", "en" Swedish 1 and Dutch "and").
 */
const isGlue = (r: Resolved) =>
  r.item.kind === 'and' ||
  r.item.kind === 'repeat' ||
  (r.item.kind === 'number' && !r.counted && CONNECTORS.has(r.item.word))

/** The lowest place a group has filled: 500 → 100, 50 → 10, 55 → 1. */
const lowestPlace = (value: number) => {
  let place = 1
  while (value % (place * 10) === 0) place *= 10
  return place
}

/**
 * The digits in what the caller said, with a leading + when they said "plus" first. Number words and numerals both
 * count, in any of the assistant languages; "double five" is 55, "twenty one" 21, "five hundred" 500, "quinhentos e
 * três" 503, "cinquante-cinq" 55, "zero um" 01. Everything else (fillers, "area code", dashes) is skipped.
 */
export function spokenDigits(text: string): string {
  let out = ''
  let repeat = 1
  type Group = { value: number; tail: number; closed: boolean; takesTeen: boolean }
  let group: Group | null = null
  const close = () => {
    if (group) out += String(group.value)
    group = null
  }
  const start = (word: Entry) => {
    close()
    const closed = !!word.closed || word.value === 0
    group = { value: word.value, tail: word.times ? 0 : word.value, closed, takesTeen: !!word.takesTeen }
  }
  for (const r of resolve(items(text))) {
    const { item } = r
    if (item.brk !== 'none') close()
    if (item.kind === 'and' || (item.kind === 'number' && !r.counted && CONNECTORS.has(item.word))) continue
    if (item.kind === 'plus') {
      if (!out && !group) out = '+'
      else close()
      repeat = 1
      continue
    }
    if (item.kind === 'repeat') {
      close()
      repeat = item.times
      continue
    }
    if (item.kind === 'numerals') {
      close()
      if (item.plus && !out) out = '+'
      out += repeat > 1 && item.digits.length === 1 ? item.digits.repeat(repeat) : item.digits
      repeat = 1
      continue
    }
    if (item.kind === 'other' || !r.counted || !r.word) {
      close()
      repeat = 1
      continue
    }
    const word = r.word
    const g = group as Group | null
    if (repeat > 1) {
      close()
      if (word.value < 10 && !word.times) out += String(word.value).repeat(repeat)
      else start(word)
      repeat = 1
      continue
    }
    if (word.times) {
      // "five hundred", "twenty five hundred", 五十: what was said since the last multiplier, times this.
      if (g && g.tail > 0 && g.tail < word.value) {
        g.value += g.tail * (word.value - 1)
        g.tail = 0
        g.closed = false
        g.takesTeen = false
      } else start(word)
    } else if (word.score && g && g.value === 4 && g.tail === 4) {
      // quatre-vingt
      g.value = 80
      g.tail = 80
      g.takesTeen = true
    } else if (
      g &&
      word.value > 0 &&
      g.value > 0 &&
      !g.closed &&
      (word.value < lowestPlace(g.value) || (g.takesTeen && word.value >= 10 && word.value < 20))
    ) {
      g.value += word.value
      g.tail += word.value
      g.closed = !!word.closed
      g.takesTeen = !!word.takesTeen
    } else start(word)
  }
  close()
  return out === '+' ? '' : out
}
