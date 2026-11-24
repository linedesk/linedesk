// Forwarding guides for the UK, Ireland, Germany, Austria, Switzerland, the Netherlands, Belgium and Luxembourg (researched 15.11.2026).
// Sourcing rule and fields: see ../forwarding-guides.ts and ./shared.ts.
import {
  APPLE_CALL_FORWARDING,
  type ForwardingGuide,
  GSM_CHECK,
  GSM_STANDARD,
  gsmModes,
  phoneMenuModes,
} from './shared.ts'

const TELEKOM_MOBILFUNK_STEUERCODES = {
  url: 'https://www.telekom.de/hilfe/mobilfunk/telefonie-nachrichten/steuercodes',
  label: 'Telekom: Mobilfunk-Steuercodes',
}
const BT_BUSINESS_CALL_DIVERT = {
  url: 'https://business.bt.com/help/article/bt-mobile/mobile-features/set-up-call-divert-mobile/',
  label: 'BT Business: call divert on your mobile',
}
const VODAFONE_UK_MANAGE_CALL = {
  url: 'https://www.vodafone.co.uk/help/mobile/how-do-i-manage-call-diverts',
  label: 'Vodafone UK: manage call diverts',
}
const VODAFONE_IRELAND_CALLS_TEXTS = {
  url: 'https://n.vodafone.ie/support/mobile/calls-texts-and-voicemail.html',
  label: 'Vodafone Ireland: calls, texts and voicemail (call diverts)',
}
const MAGENTA_GSM_CODES_PDF = {
  url: 'https://www.magenta.at/content/dam/magenta_at/pdfs/consumer/faq/Magenta_GSM-Codes_0519.pdf',
  label: 'Magenta: GSM-Codes (PDF)',
}
const SWISSCOM_SET_UP_CALL = {
  url: 'https://www.swisscom.ch/en/residential/help/fixed-network/stay-available.html',
  label: 'Swisscom: set up call forwarding',
}
const SUNRISE_CALL_SETTINGS_MOBILE = {
  url: 'https://web.archive.org/web/20260122071504/https://www.sunrise.ch/en/support/mobile/usage-and-settings/call-settings',
  label: 'Sunrise: call settings mobile (archived copy, sunrise.ch was down)',
}
const KPN_MOBIEL_DOORSCHAKELEN = {
  url: 'https://www.kpn.com/service/ugs/doorschakelen-mobiel',
  label: 'KPN: mobiel doorschakelen',
}
const PROXIMUS_DEVIER_LES_APPELS = {
  url: 'https://www.proximus.be/fr/id_b_cr_call_forwarding/particuliers/blog/news/le-bon-conseil-de/comment-devier-appels-gsm-ligne-fixe.html',
  label: 'Proximus: dévier les appels de votre GSM ou ligne fixe',
}
const BASE_CALL_TRANSFER_TO = {
  url: 'https://www.base.be/en/support/mobile/your-smartphone/all-about-call-transfer-to-another-number.html',
  label: 'BASE: call transfer to another number',
}
const POST_NETWORK_CODES_POST = {
  url: 'https://www.post.lu/documents/20125/889515/Codes_r%C3%A9seau_mobile+POST_EN.pdf/9981d388-7b77-daae-4967-3294bbd95324?t=1646907028307',
  label: 'POST: network codes POST mobile (PDF)',
}

export const europeNorthWestGuides: readonly ForwardingGuide[] = [
  {
    id: 'de-telekom',
    name: 'Telekom',
    kind: 'mobile',
    countries: ['DE'],
    aliases: ['telekom', 'deutsche telekom', 'telekom deutschland', 't-mobile', 'magenta', 'magentamobil'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Your Telekom Mobilbox is itself a forwarding to 3311. These codes replace it, so missed calls reach your assistant instead of the Mobilbox.',
      'Don’t switch the Mobilbox back on later: that points missed calls at 3311 again.',
      'To get the Mobilbox back after turning forwarding off, dial **004*3311#.',
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
      'The SMS notice for missed calls stops while a forwarding is set.',
    ],
    sources: [TELEKOM_MOBILFUNK_STEUERCODES],
  },
  {
    id: 'de-vodafone',
    name: 'Vodafone',
    kind: 'mobile',
    countries: ['DE'],
    aliases: ['vodafone', 'vodafone deutschland', 'vodafone gmbh', 'd2'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Your Vodafone Mailbox is a forwarding to 5500. These codes replace it, so missed calls reach your assistant instead of the Mailbox.',
      'To get the Mailbox back after turning forwarding off, dial **004*5500#.',
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
    ],
    sources: [
      {
        url: 'https://www.vodafone.de/featured/article/vodafone-service-codes-die-praktischsten-tricks-fuer-dein-smartphone-181056',
        label: 'Vodafone: Service-Codes (Anrufumleitung)',
      },
      {
        url: 'https://www.vodafone.de/featured/article/so-wirst-du-zum-mailbox-profi-25609',
        label: 'Vodafone: Mailbox codes',
      },
    ],
  },
  {
    id: 'de-o2',
    name: 'O2 (Telefónica)',
    kind: 'mobile',
    countries: ['DE'],
    aliases: ['o2', 'o2 germany', 'telefonica', 'telefónica', 'telefonica germany', 'e-plus'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'o2 documents these codes with its Mailbox number 333; for your assistant they take its number instead.',
    pitfalls: [
      'The o2 Mailbox is switched on with every contract and is a forwarding to 333. These codes replace it, so missed calls reach your assistant instead.',
      'To get the Mailbox back after turning forwarding off, dial **004*333#.',
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
    ],
    sources: [
      {
        url: 'https://www.o2online.de/service/mailbox-voicemail/',
        label: 'o2: Mailbox and Rufumleitung codes',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'de-1und1',
    name: '1&1',
    kind: 'mobile',
    countries: ['DE'],
    aliases: ['1&1', '1und1', '1 und 1', 'eins und eins', '1&1 telecom', '1&1 mobilfunk'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: '1&1 writes the number with 0049 in front; the +49 form shown here is the same number.',
    pitfalls: [
      '1&1 can’t forward to a number outside Germany: your assistant needs a German number.',
      'The ring time before a missed call forwards can’t be changed on the 1&1 network.',
      'Setting a forwarding replaces the 1&1 Mailbox for those calls.',
      'Forwarded calls can cost extra, depending on your plan.',
    ],
    sources: [
      {
        url: 'https://hilfe-center.1und1.de/rufumleitung-mobilfunknummer',
        label: '1&1: Rufumleitung für Ihre Mobilfunknummer',
      },
    ],
  },
  {
    id: 'de-other-mobile',
    name: 'Another mobile carrier (Germany)',
    kind: 'mobile',
    countries: ['DE'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
    ],
    sources: [GSM_STANDARD, TELEKOM_MOBILFUNK_STEUERCODES],
  },
  {
    id: 'de-telekom-festnetz',
    name: 'Telekom Festnetz (MagentaZuhause, Glasfaser)',
    kind: 'landline',
    countries: ['DE'],
    aliases: [
      'telekom festnetz',
      'magentazuhause',
      'magenta zuhause',
      'deutsche telekom festnetz',
      'telekom glasfaser',
      't-home',
    ],
    how: 'settings',
    where: 'the Telekom Telefoniecenter',
    modes: {
      forward_conditional: {
        on: [
          'Open the Telefoniecenter and sign in with your Telekom login.',
          'Choose the phone number › Weiter › “Anrufweiterleitung” under “Erreichbarkeit”.',
          '“Weiterleitung hinzufügen”: tick “nach 25 Sekunden” and “bei besetzt”.',
          'Enter {number} as the destination › Speichern.',
        ],
        off: ['In the same place, choose “Weiterleitung deaktivieren”.'],
      },
      forward_all: {
        on: [
          'Telefoniecenter › your number › “Anrufweiterleitung” › “Weiterleitung hinzufügen”.',
          'Tick “sofort”, enter {number} › Speichern. From the desk phone: *21*{number}#, then wait for the announcement.',
        ],
        off: ['Choose “Weiterleitung deaktivieren” in the same place, or dial #21# from the desk phone.'],
      },
    },
    check: 'Telefoniecenter › your number › Anrufweiterleitung',
    note: 'Telekom also lists desk-phone codes (*21*, *61*, *67*), but no off code for missed-call forwarding, so missed calls are set in the Telefoniecenter.',
    pitfalls: [
      'Set it for each phone number on the line; the setting is per number.',
      'Missed calls forward after 25 seconds; the Telefoniecenter offers no other time.',
      'If you have a Fritz!Box or other router with its own forwarding, set it in one place only.',
    ],
    sources: [
      {
        url: 'https://www.telekom.de/hilfe/internet-telefonie/telefonie/anrufweiterleitungen',
        label: 'Telekom: Festnetz Anrufweiterleitung einrichten',
      },
    ],
  },
  {
    id: 'de-vodafone-kabel',
    name: 'Vodafone Kabel or DSL (Festnetz)',
    kind: 'landline',
    countries: ['DE'],
    aliases: [
      'vodafone kabel',
      'vodafone festnetz',
      'vodafone dsl',
      'kabel deutschland',
      'vodafone station',
      'gigacable',
    ],
    how: 'settings',
    where: 'MeinVodafone',
    modes: {
      forward_conditional: {
        on: [
          'Sign in to MeinVodafone and choose your cable contract › Einstellungen › Telefoneinstellungen.',
          'Scroll to “Weiterleitung” › “Weiterleitung ändern”.',
          'Choose “Nach 30 Sekunden” (and “Bei besetzter Leitung”), enter {number} without spaces.',
          'Enter the security code › Einstellungen speichern. It works after a few minutes.',
        ],
        off: ['Turn the forwarding off under “Weiterleitung” in the same place.'],
      },
      forward_all: {
        on: [
          'MeinVodafone › your cable contract › Einstellungen › Telefoneinstellungen › “Weiterleitung ändern”.',
          'Choose “Sofort”, enter {number} › security code › Einstellungen speichern.',
          'DSL contracts: MeinVodafone › your DSL contract › Meine Produkte › Konfiguration Sprache › Rufumleitung › edit › {number} › Speichern.',
        ],
        off: ['Turn the forwarding off in the same place.'],
      },
    },
    check: 'MeinVodafone › your contract › Telefoneinstellungen › Weiterleitung',
    note: 'If your Vodafone line runs through a Fritz!Box, use the Fritz!Box guide.',
    pitfalls: [
      'Vodafone shows this route for cable lines outside Hessen, Baden-Württemberg and NRW. In those regions (former Unitymedia) set it on your router instead.',
      'Missed calls forward after 30 seconds on cable lines.',
    ],
    sources: [
      {
        url: 'https://forum.vodafone.de/t5/Community-Blog/So-richtest-Du-eine-Festnetz-Rufumleitung-ein/ba-p/3007391',
        label: 'Vodafone Community blog: Festnetz-Rufumleitung einrichten',
      },
    ],
  },
  {
    id: 'de-1und1-festnetz',
    name: '1&1 Festnetz (DSL, Glasfaser)',
    kind: 'landline',
    countries: ['DE'],
    aliases: ['1&1 festnetz', '1und1 festnetz', '1&1 dsl', '1&1 glasfaser'],
    how: 'settings',
    where: 'the 1&1 Control-Center',
    modes: {
      forward_all: {
        on: [
          'Sign in to the 1&1 Control-Center › Vertrag › your internet and phone contract.',
          'Choose “Weiterleitung” › select your phone number.',
          'Tick “Anrufe weiterleiten”, enter {number} › Speichern.',
        ],
        off: ['In the same place, select the number › “Anrufe nicht weiterleiten” › Speichern.'],
      },
    },
    check: '1&1 Control-Center › Vertrag › Weiterleitung (a tick marks numbers that forward)',
    note: 'The Control-Center forwards every call. For missed calls only, set it on the 1&1 router (a Fritz!Box): use the Fritz!Box guide.',
    pitfalls: ['Calls to the forwarding number can cost extra, depending on your plan and the number.'],
    sources: [
      {
        url: 'https://hilfe-center.1und1.de/rufumleitung-einrichten',
        label: '1&1: Rufumleitung für Festnetznummer',
      },
    ],
  },
  {
    id: 'gb-ee',
    name: 'EE',
    kind: 'mobile',
    countries: ['GB'],
    aliases: ['ee', 'everything everywhere', 'ee limited', 'orange uk', 't-mobile uk'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'EE shows these codes in its device guides; BT Mobile (on EE’s network) documents the same codes with +44.',
    pitfalls: [
      'EE diverts only to UK numbers: your assistant needs a UK number.',
      'Set diverts on the phone itself; EE customer service can’t set them for you. Calling 150 › 1 › 2 › 4 › 1 also works.',
      'A diverted call is charged like a call from your plan to that number.',
      '##002# cancels every divert, including the one to EE voicemail.',
    ],
    sources: [
      {
        url: 'https://business.ee.co.uk/help/ee-getting-started/manage-call-diverts/',
        label: 'EE Business: how to manage call diverts',
      },
      {
        url: 'https://deviceguides.ee.co.uk/web/apple/iphone-11-ios-26/calls-contacts-messaging/diverting-calls-to-voicemail/',
        label: 'EE device guide: diverting calls (codes)',
      },
      BT_BUSINESS_CALL_DIVERT,
      GSM_STANDARD,
    ],
  },
  {
    id: 'gb-bt-mobile',
    name: 'BT Mobile',
    kind: 'mobile',
    countries: ['GB'],
    aliases: ['bt mobile', 'bt business mobile'],
    network: 'EE',
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Write the number with +44 instead of the first 0, as shown.',
      'Missed calls divert after 15 seconds.',
      '##002# switches off every divert.',
    ],
    sources: [BT_BUSINESS_CALL_DIVERT],
  },
  {
    id: 'gb-vodafone',
    name: 'Vodafone UK',
    kind: 'mobile',
    countries: ['GB'],
    aliases: ['vodafone', 'vodafone uk', 'vodafone limited', 'vodafonethree'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'Vodafone also documents a ring-time change in its own format; it isn’t used here.',
    pitfalls: [
      'Write the number with +44 instead of the first 0, as shown.',
      '##002# cancels every divert at once.',
      'If the codes are refused right after you moved to Vodafone, turning off Wi-Fi Calling while you dial them can help.',
    ],
    sources: [VODAFONE_UK_MANAGE_CALL],
  },
  {
    id: 'gb-o2',
    name: 'O2 (UK)',
    kind: 'mobile',
    countries: ['GB'],
    aliases: ['o2 uk', 'o2', 'telefonica uk', 'virgin media o2'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'O2 documents diverts in the phone’s call forwarding settings, not with codes.',
    pitfalls: ['O2 voicemail (901) is itself a divert for unanswered calls; your divert replaces it.'],
    sources: [
      {
        url: 'https://www.o2.co.uk/help/phones-sims-and-devices/google/pixel-8-android-14/basic-settings/cancel-all-diverts',
        label: 'O2: call forwarding settings (Pixel 8 guide)',
      },
      APPLE_CALL_FORWARDING,
    ],
  },
  {
    id: 'gb-three',
    name: 'Three (UK)',
    kind: 'mobile',
    countries: ['GB'],
    aliases: ['three uk', 'three', '3 uk', 'hutchison 3g'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Three publishes no divert codes we could verify; use the phone’s call forwarding settings.',
    pitfalls: [
      'If the phone’s forwarding setting is missing or greyed out, ask Three customer service to set the divert.',
    ],
    sources: [APPLE_CALL_FORWARDING],
  },
  {
    id: 'gb-other-mobile',
    name: 'Another mobile carrier (UK)',
    kind: 'mobile',
    countries: ['GB'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
      'Write the number with +44 instead of the first 0.',
    ],
    sources: [GSM_STANDARD, VODAFONE_UK_MANAGE_CALL, BT_BUSINESS_CALL_DIVERT],
  },
  {
    id: 'gb-bt-landline',
    name: 'BT landline',
    kind: 'landline',
    countries: ['GB'],
    aliases: ['bt', 'british telecom', 'bt business', 'bt digital voice', 'bt landline', 'bt phone line'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 15,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered within 15 seconds',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'Call Diversion is a paid add-on on BT lines: order it first, or the line says “this service is not available”.',
      'An intermittent dial tone means a divert is on (or, with Call Minder, a new message).',
      'The diverted part of each call is charged at BT’s standard rates.',
      'Outgoing call barring stops diverts from working.',
    ],
    sources: [
      {
        url: 'https://business.bt.com/help/article/phone-line-and-services/call-diversion/using-call-diversion-to-forward-calls/',
        label: 'BT Business: using call diversion',
      },
    ],
  },
  {
    id: 'gb-virgin-media-landline',
    name: 'Virgin Media home phone',
    kind: 'landline',
    countries: ['GB'],
    aliases: ['virgin media', 'virgin media phone', 'virgin media landline', 'virgin media business'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
            when: 'Green, Blue, Yellow or Purple area',
          },
          {
            code: '*70{number}',
            when: 'Red area',
          },
        ],
        off: [
          {
            code: '#21#',
            when: 'Green, Blue, Yellow or Purple area',
          },
          {
            code: '#70',
            when: 'Red area',
          },
        ],
      },
    },
    check: [
      {
        code: '*#21#',
        when: 'Every call (not in Red areas)',
      },
    ],
    note: 'Virgin Media only documents diverting every call.',
    pitfalls: [
      'Call 1765 first to hear your area colour; Red areas use a different code.',
      'Dial the star code, wait for the tone, then the number.',
      'Free Voicemail stops working while a divert is on.',
      'Turning it off can take up to 24 hours.',
    ],
    sources: [
      {
        url: 'https://www.virginmedia.com/help/landline/set-up-call-diversion',
        label: 'Virgin Media: call diversion on landline',
      },
    ],
  },
  {
    id: 'ie-vodafone',
    name: 'Vodafone Ireland',
    kind: 'mobile',
    countries: ['IE'],
    aliases: ['vodafone ireland', 'vodafone ie', 'vodafone'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    pitfalls: [
      'Vodafone diverts only to numbers in the Republic of Ireland: your assistant needs an Irish number.',
      'Each diverted call costs 16c (incl. VAT); diverting to voicemail is free.',
      'Pay as you go needs at least 15c credit.',
      'The ring time can be 5 to 30 seconds (20 by default).',
    ],
    sources: [VODAFONE_IRELAND_CALLS_TEXTS],
  },
  {
    id: 'ie-three',
    name: 'Three (Ireland)',
    kind: 'mobile',
    countries: ['IE'],
    aliases: ['three', 'three ireland', 'three ie', '3 ireland'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Three Ireland publishes no divert codes we could open; use the phone’s call forwarding settings.',
    pitfalls: ['Three Prepay lines may not be able to divert to another number.'],
    sources: [APPLE_CALL_FORWARDING],
  },
  {
    id: 'ie-eir-mobile',
    name: 'eir mobile',
    kind: 'mobile',
    countries: ['IE'],
    aliases: ['eir mobile', 'eircom mobile', 'meteor'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'eir publishes no mobile divert codes we could open; use the phone’s call forwarding settings.',
    pitfalls: ['Diverted calls are charged like a call to that number.'],
    sources: [APPLE_CALL_FORWARDING],
  },
  {
    id: 'ie-other-mobile',
    name: 'Another mobile carrier (Ireland)',
    kind: 'mobile',
    countries: ['IE'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
    ],
    sources: [GSM_STANDARD, VODAFONE_IRELAND_CALLS_TEXTS],
  },
  {
    id: 'ie-eir-landline',
    name: 'eir landline',
    kind: 'landline',
    countries: ['IE'],
    aliases: ['eir', 'eircom', 'eir business', 'eir landline', 'open eir'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    note: 'eir only documents forwarding every call on a landline.',
    pitfalls: [
      'Lift the receiver first, then dial the code.',
      'eir charges about 31c to set it up, plus each forwarded call at standard rates.',
      'eir Broadband Talk uses a different code (*211).',
    ],
    sources: [
      {
        url: 'https://www.eir.ie/business/support/landline/phone-services/call_forwarding/',
        label: 'eir Business: call forwarding',
      },
    ],
  },
  {
    id: 'at-a1',
    name: 'A1',
    kind: 'mobile',
    countries: ['AT'],
    aliases: ['a1', 'a1 telekom', 'a1 telekom austria', 'mobilkom'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'A1’s code sheet shows these codes with the Mobilbox number; for your assistant they take its number instead.',
    pitfalls: [
      'Your A1 Mobilbox is itself a forwarding; these codes replace it for those calls.',
      '##002# deletes every forwarding, including the one to the Mobilbox.',
    ],
    sources: [
      {
        url: 'https://cdn3.a1.net/final/de/media/pdf/SLR_Codes_Rufumleitung.pdf',
        label: 'A1: Codes für Rufumleitungen (PDF)',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'at-magenta',
    name: 'Magenta Telekom',
    kind: 'mobile',
    countries: ['AT'],
    aliases: ['magenta', 'magenta telekom', 't-mobile austria', 'tele.ring', 'telering'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: ['The ring time can be up to 30 seconds (20 by default).', '##002# deletes every forwarding at once.'],
    sources: [MAGENTA_GSM_CODES_PDF],
  },
  {
    id: 'at-drei',
    name: 'Drei',
    kind: 'mobile',
    countries: ['AT'],
    aliases: ['drei', 'drei austria', 'hutchison drei', '3 austria'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
      'Forwarding can also be set in the Drei Kundenzone › Einstellungen › Anrufeinstellung.',
    ],
    sources: [
      {
        url: 'https://www.drei.at/de/planet-drei/blog/artikel/rufumleitung-iphone.html',
        label: 'Drei: Rufumleitung am iPhone (codes)',
      },
      {
        url: 'https://www.drei.at/de/hilfe/kundenzone/einstellungen/anrufeinstellungen-vornehmen.html',
        label: 'Drei: Anrufeinstellungen in der Kundenzone',
      },
    ],
  },
  {
    id: 'at-other-mobile',
    name: 'Another mobile carrier (Austria)',
    kind: 'mobile',
    countries: ['AT'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
    ],
    sources: [GSM_STANDARD, MAGENTA_GSM_CODES_PDF],
  },
  {
    id: 'ch-swisscom-mobile',
    name: 'Swisscom (mobile)',
    kind: 'mobile',
    countries: ['CH'],
    aliases: ['swisscom', 'swisscom mobile'],
    how: 'settings',
    where: 'the Swisscom Cockpit or your phone’s settings',
    modes: phoneMenuModes,
    check: 'Swisscom Cockpit › Call Settings',
    note: 'Swisscom documents mobile forwarding in the Cockpit and the phone’s settings, not with codes.',
    pitfalls: [
      'You can also set and turn off forwarding in the Swisscom Cockpit under Call Settings.',
      'Your COMBOX® is itself a forwarding; yours replaces it for those calls.',
      'Forwarding is free; the forwarded call costs what a call to that number costs on your plan.',
    ],
    sources: [
      SWISSCOM_SET_UP_CALL,
      {
        url: 'https://www.swisscom.ch/en/residential/help/mobile/combox.html',
        label: 'Swisscom: COMBOX®',
      },
    ],
  },
  {
    id: 'ch-sunrise',
    name: 'Sunrise (mobile)',
    kind: 'mobile',
    countries: ['CH'],
    aliases: ['sunrise', 'sunrise mobile', 'sunrise upc'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 25,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered within 25 seconds',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
          {
            code: '#62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'Forwarding every call isn’t available on Sunrise Prepaid.',
      'Forwarded calls to numbers not included in your plan are charged like a call to them.',
    ],
    sources: [SUNRISE_CALL_SETTINGS_MOBILE],
  },
  {
    id: 'ch-salt',
    name: 'Salt (mobile)',
    kind: 'mobile',
    countries: ['CH'],
    aliases: ['salt', 'salt mobile', 'orange switzerland'],
    domesticOnly: true,
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Salt documents no mobile forwarding codes we could open; use the phone’s call forwarding settings.',
    pitfalls: [
      'Salt voicemail is on by default and is itself a forwarding; yours replaces it for those calls.',
      'Salt only forwards to Swiss numbers: your assistant needs a Swiss number.',
    ],
    sources: [
      {
        url: 'https://www.salt.ch/en/mobile/welcome',
        label: 'Salt: welcome (voicemail)',
      },
      APPLE_CALL_FORWARDING,
    ],
  },
  {
    id: 'ch-other-mobile',
    name: 'Another mobile carrier (Switzerland)',
    kind: 'mobile',
    countries: ['CH'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
    ],
    sources: [GSM_STANDARD, SUNRISE_CALL_SETTINGS_MOBILE],
  },
  {
    id: 'ch-swisscom-landline',
    name: 'Swisscom landline',
    kind: 'landline',
    countries: ['CH'],
    aliases: ['swisscom festnetz', 'swisscom landline', 'swisscom fixed network', 'blue home'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 25,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61{number}',
            when: 'Not answered within 25 seconds',
          },
          {
            code: '*67{number}',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21{number}',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'Lift the handset, dial the code, wait for the confirmation, then hang up.',
      'It can also be set and turned off in My Swisscom › Call Settings.',
      'Immediate forwarding can’t be combined with simultaneous ringing.',
      'Forwarding is free; the forwarded call costs what a call to that number costs on your plan.',
    ],
    sources: [SWISSCOM_SET_UP_CALL],
  },
  {
    id: 'ch-sunrise-landline',
    name: 'Sunrise landline',
    kind: 'landline',
    countries: ['CH'],
    aliases: ['sunrise festnetz', 'sunrise landline', 'upc', 'upc schweiz'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 25,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered within 25 seconds',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'Turn off call waiting first (#43#): with it on, forwarding can’t be set.',
      'Former UPC lines lost their old forwarding settings; set them again.',
      'Pick up the receiver, dial the code, wait for the confirmation, then hang up.',
    ],
    sources: [
      {
        url: 'https://web.archive.org/web/20251107124005/https://www.sunrise.ch/en/support/landline-telephony/using-the-landline-network/forwarding-calls',
        label: 'Sunrise: forwarding landline calls (archived copy, sunrise.ch was down)',
      },
    ],
  },
  {
    id: 'ch-salt-home',
    name: 'Salt Home (landline)',
    kind: 'landline',
    countries: ['CH'],
    aliases: ['salt home', 'salt fiber', 'salt landline'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}*20#',
            when: 'Not answered within 20 seconds',
          },
          {
            code: '*69*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#69#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61#',
        when: 'Not answered',
      },
      {
        code: '*#69#',
        when: 'Busy',
      },
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Salt uses 69 (not 67) for busy calls.',
      'Only Swiss numbers: your assistant needs a Swiss number.',
      'It can also be set in My Account › Subscriptions › Telephony.',
    ],
    sources: [
      {
        url: 'https://www.salt.ch/en/help/home/telephony',
        label: 'Salt Home: telephony help',
      },
    ],
  },
  {
    id: 'nl-kpn',
    name: 'KPN',
    kind: 'mobile',
    countries: ['NL'],
    aliases: ['kpn', 'kpn mobiel', 'kpn mobile'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'If the network shows an error (calling over 4G), start each code with one star instead of two and leave out the # at the end; turn it off with #61 (or #62, #67, #21).',
      'Forwarding is free to set; the forwarded call costs a normal call.',
    ],
    sources: [KPN_MOBIEL_DOORSCHAKELEN],
  },
  {
    id: 'nl-odido',
    name: 'Odido',
    kind: 'mobile',
    countries: ['NL'],
    aliases: ['odido', 't-mobile netherlands', 't-mobile nl', 'tele2 nl'],
    how: 'dial',
    numberFormat: 'national',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Type the number without spaces.',
      'It can also be set in Mijn Odido.',
      '##002# removes every forwarding at once.',
    ],
    sources: [
      {
        url: 'https://www.odido.nl/service/veelgestelde-vragen/hoe-kan-ik-telefoongesprekken-doorschakelen/000453052',
        label: 'Odido: telefoongesprekken doorschakelen',
      },
    ],
  },
  {
    id: 'nl-vodafone',
    name: 'Vodafone (Netherlands)',
    kind: 'mobile',
    countries: ['NL'],
    aliases: ['vodafone', 'vodafone nl', 'vodafone netherlands', 'vodafoneziggo'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'If the network shows an error (calling over 4G), start each code with one star instead of two and leave out the # at the end; turn it off with #61 (or #62, #67, #21).',
      '##002# removes every forwarding at once.',
    ],
    sources: [
      {
        url: 'https://www.vodafone.nl/telefoon/telefoon-doorschakelen',
        label: 'Vodafone: telefoon doorschakelen',
      },
    ],
  },
  {
    id: 'nl-other-mobile',
    name: 'Another mobile carrier (Netherlands)',
    kind: 'mobile',
    countries: ['NL'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
    ],
    sources: [GSM_STANDARD, KPN_MOBIEL_DOORSCHAKELEN],
  },
  {
    id: 'nl-kpn-vast',
    name: 'KPN vaste lijn',
    kind: 'landline',
    countries: ['NL'],
    aliases: ['kpn vast', 'kpn vaste lijn', 'kpn vast bellen', 'kpn landline'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered after 5 rings',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'KPN can’t forward to a number abroad: your assistant needs a Dutch number.',
      'It can also be set in MijnKPN › Vast Bellen › Telefooninstellingen › Nummers doorschakelen.',
      'Setting it is free; the forwarded call costs a normal call.',
    ],
    sources: [
      {
        url: 'https://www.kpn.com/service/ugs/doorschakelen-vaste-telefoon',
        label: 'KPN: vaste telefoon doorschakelen',
      },
    ],
  },
  {
    id: 'be-proximus',
    name: 'Proximus',
    kind: 'mobile',
    countries: ['BE'],
    aliases: ['proximus', 'belgacom'],
    how: 'dial',
    numberFormat: 'international',
    ringSeconds: 20,
    modes: gsmModes(20, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
      'Your voicemail is itself a forwarding; yours replaces it for those calls.',
    ],
    sources: [PROXIMUS_DEVIER_LES_APPELS],
  },
  {
    id: 'be-orange',
    name: 'Orange Belgium',
    kind: 'mobile',
    countries: ['BE'],
    aliases: ['orange', 'orange belgium', 'orange be', 'mobistar'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'Missed calls forward after 20 seconds.',
      'Setting it is free; the forwarded call costs a normal call.',
      'Forwarding every call wins over forwarding to voicemail, which wins over forwarding to another number.',
    ],
    sources: [
      {
        url: 'https://www.orange.be/fr/support/assistance-technique/telephonie-mobile/comment-transferer-vos-appels-vers-un-autre-numero',
        label: 'Orange: transférer vos appels vers un autre numéro',
      },
    ],
  },
  {
    id: 'be-base',
    name: 'BASE',
    kind: 'mobile',
    countries: ['BE'],
    aliases: ['base', 'base belgium'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      'BASE forwards only to Belgian numbers: your assistant needs a Belgian number.',
      'Diverted calls are charged like a call to that number.',
    ],
    sources: [BASE_CALL_TRANSFER_TO],
  },
  {
    id: 'be-telenet',
    name: 'Telenet (mobile)',
    kind: 'mobile',
    countries: ['BE'],
    aliases: ['telenet', 'telenet mobiel', 'telenet mobile'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    pitfalls: [
      '##002# turns off every forwarding, including voicemail.',
      'In some countries abroad, forwarding is lifted when you restart the phone.',
    ],
    sources: [
      {
        url: 'https://www2.telenet.be/business/nl/klantenservice/mobiele-telefonie/mobiel-instellen-en-gebruiken/handige-codes-voor-mobiel.html',
        label: 'Telenet: handige codes voor mobiel',
      },
    ],
  },
  {
    id: 'be-other-mobile',
    name: 'Another mobile carrier (Belgium)',
    kind: 'mobile',
    countries: ['BE'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
    ],
    sources: [GSM_STANDARD, BASE_CALL_TRANSFER_TO],
  },
  {
    id: 'be-proximus-fixe',
    name: 'Proximus landline',
    kind: 'landline',
    countries: ['BE'],
    aliases: ['proximus fixe', 'proximus vaste lijn', 'proximus landline', 'belgacom fixe'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#67#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [
          {
            code: '#21#',
          },
        ],
      },
    },
    pitfalls: [
      'Call forwarding (Déviation d’appel) is a paid option on Proximus landlines: order it first.',
      'You can also call 1987 (Phone Manager) and choose 1 to set it by voice menu.',
    ],
    sources: [PROXIMUS_DEVIER_LES_APPELS],
  },
  {
    id: 'lu-post',
    name: 'POST Luxembourg',
    kind: 'mobile',
    countries: ['LU'],
    aliases: ['post', 'post luxembourg', 'post telecom', 'pt luxembourg'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    note: 'POST forwards only to numbers in Luxembourg, Belgium, the Netherlands, France and Germany.',
    pitfalls: [
      'POST only forwards to numbers in Luxembourg, Belgium, the Netherlands, France and Germany.',
      'Write the number in international format (+352…), as POST asks.',
      '##002# cancels every forwarding.',
    ],
    sources: [
      POST_NETWORK_CODES_POST,
      {
        url: 'https://www.post.lu/en/particuliers/support/telephonie-mobile/gestion-des-appels-et-messagerie-vocale/gestion-des-appels/deviation-des-appels',
        label: 'POST: how does call forwarding work?',
      },
    ],
  },
  {
    id: 'lu-orange',
    name: 'Orange Luxembourg',
    kind: 'mobile',
    countries: ['LU'],
    aliases: ['orange', 'orange luxembourg', 'orange lu'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Orange Luxembourg documents no forwarding codes we could open; use the phone’s call forwarding settings.',
    pitfalls: ['Your Orange voicemail is itself a forwarding; ##002# cancels it along with every other forwarding.'],
    sources: [
      {
        url: 'https://www.orange.lu/en/news/roaming-our-tips/',
        label: 'Orange Luxembourg: roaming tips (##002#)',
      },
      APPLE_CALL_FORWARDING,
    ],
  },
  {
    id: 'lu-tango',
    name: 'Tango',
    kind: 'mobile',
    countries: ['LU'],
    aliases: ['tango', 'tango luxembourg', 'proximus luxembourg'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Tango publishes no forwarding codes we could find; use the phone’s call forwarding settings, or ask Tango.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING],
  },
  {
    id: 'lu-other-mobile',
    name: 'Another mobile carrier (Luxembourg)',
    kind: 'mobile',
    countries: ['LU'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, {
      on: [
        {
          code: '**21*{number}#',
        },
      ],
      off: [
        {
          code: '##21#',
        },
      ],
    }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most carriers in the country use. If yours documents others, follow your carrier.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'If a code is refused, use the phone’s own call forwarding settings, or ask your carrier.',
      'Write the number in international format (+352…).',
    ],
    sources: [GSM_STANDARD, POST_NETWORK_CODES_POST],
  },
]
