// Forwarding guides for Australia, New Zealand, India, Singapore, Japan, the Philippines, South Africa, the UAE and Israel (researched 15.11.2026).
// Sourcing rule and fields: see ../forwarding-guides.ts and ./shared.ts.
import { type ForwardingGuide, GSM_CHECK, GSM_STANDARD, gsmModes, type SettingsGuide } from './shared.ts'

const TELSTRA_FORWARD_CALLS_ON = {
  url: 'https://telstra.com.au/small-business/online-support/mobiles-devices/forward-calls-on-mobile',
  label: 'Telstra: forward calls on your mobile',
}
const OPTUS_MANAGE_CALL_DIVERSIONS = {
  url: 'https://www.optus.com.au/support/answer/manage_call_diversions_on_your_mobile_phone_1764',
  label: 'Optus: manage call diversions on your mobile',
}
const VODAFONE_AUSTRALIA_CALL_FORWARDING = {
  url: 'https://www.vodafone.com.au/support/device/call-forwarding',
  label: 'Vodafone Australia: call forwarding',
}
const ONE_NZ_SET_UP = {
  url: 'https://one.nz/faq/set-up-mobile-call-divert',
  label: 'One NZ: set up mobile call divert',
}
const SPARK_SET_UP_CALL = {
  url: 'https://www.spark.co.nz/help/mobile/manage/mobile-call-features/',
  label: 'Spark: set up call diversion on your mobile',
}
const APPLE_SET_UP_CALL = {
  url: 'https://support.apple.com/en-asia/guide/iphone/iphe9bdd027a/18.0/ios/18.0',
  label: 'Apple: set up call forwarding on iPhone',
}
const SAMSUNG_AUSTRALIA_CALL_FORWARDING = {
  url: 'https://www.samsung.com/au/support/mobile-devices/forward-calling-on-samsung-phone/',
  label: 'Samsung Australia: call forwarding on Galaxy phones',
}
const VI_ACTIVATE_AND_DEACTIVATE = {
  url: 'https://www.myvi.in/blog/how-to-activate-and-deactivate-call-forwarding-code-on-vi',
  label: 'Vi: activate and deactivate call forwarding codes',
}
const SINGTEL_MANAGE_CALL_DIVERSIONS = {
  url: 'https://www.singtel.com/business/support/userguide-voicemail',
  label: 'Singtel: manage call diversions',
}
const STARHUB_MOBILE_SHORT_CODES = {
  url: 'https://web.archive.org/web/20240804103600/https://www.starhub.com/personal/how-to/mobile-short-codes-for-starhub-services.html',
  label: 'StarHub: mobile short codes (archived August 2024)',
}
const DOCOMO = {
  url: 'https://www.docomo.ne.jp/service/transfer/notice/',
  label: 'docomo: 転送でんわサービス ご注意事項',
}
const SAMSUNG_PHILIPPINES_CALL_FORWARDING = {
  url: 'https://www.samsung.com/ph/support/mobile-devices/how-to-enable-or-disable-the-call-forwarding-feature-in-your-samsung-galaxy-smartphone/',
  label: 'Samsung Philippines: call forwarding on Galaxy phones',
}
const E_UAE_MOBILE_VALUE = {
  url: 'https://www.eand.ae/en/c/mobile/value-added-services.html',
  label: 'e& UAE: mobile value-added services (call forwarding)',
}

/** The phone’s own call forwarding menu, with the labels of Samsung’s Galaxy guides in these countries. */
const galaxyMenuModes: SettingsGuide['modes'] = {
  forward_all: {
    off: ['Turn Call Forwarding (or “Always forward”) off in the same place.'],
    on: [
      'iPhone: Settings › Apps › Phone › Call Forwarding (older iPhones: Settings › Phone › Call Forwarding).',
      'Turn Call Forwarding on, tap Forward To and enter {number}.',
      'Android: Phone app › ⋮ › Settings › Supplementary services › Call forwarding › Voice calls › “Always forward” › {number}.',
    ],
  },
  forward_conditional: {
    off: ['Turn “Forward when unanswered”, “Forward when busy” and “Forward when unreachable” off in the same place.'],
    on: [
      'Android: open the Phone app › ⋮ › Settings › Supplementary services (or Calling accounts) › Call forwarding › Voice calls.',
      'Tap “Forward when unanswered”, enter {number} and turn it on. Do the same for “Forward when busy” and “Forward when unreachable”.',
      'iPhone has no setting for missed calls only: use Every call, or ask your carrier for its conditional call forwarding codes.',
    ],
  },
}

export const apacMeaGuides: readonly ForwardingGuide[] = [
  {
    id: 'au-telstra',
    name: 'Telstra',
    kind: 'mobile',
    countries: ['AU'],
    aliases: ['telstra mobile', 'telstra corporation', 'telstra business'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '**61*{number}*11#',
            when: 'Not answered',
          },
          {
            code: '**67*{number}*11#',
            when: 'Busy',
          },
          {
            code: '**62*{number}*11#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '**21*{number}*11#',
          },
        ],
        off: [
          {
            code: '##21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'Dial the codes from the phone itself, one after the other, and press Call after each.',
      'Missed calls ring for 15 seconds before they forward (Telstra’s default).',
      'Forwarding replaces MessageBank for those calls. **004*101# brings MessageBank back.',
      'Every call can also be forwarded by text: send “CFU ON {number}” to 144, and “CFU OFF” to stop.',
    ],
    sources: [TELSTRA_FORWARD_CALLS_ON],
  },
  {
    id: 'au-optus',
    name: 'Optus',
    kind: 'mobile',
    countries: ['AU'],
    aliases: ['optus mobile', 'singtel optus', 'optus business'],
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
    check: GSM_CHECK,
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
      'It can also be set in the My Optus app: Services › your mobile › call diversions.',
    ],
    sources: [OPTUS_MANAGE_CALL_DIVERSIONS, GSM_STANDARD],
  },
  {
    id: 'au-vodafone',
    name: 'Vodafone Australia',
    kind: 'mobile',
    countries: ['AU'],
    aliases: ['vodafone', 'vodafone au', 'tpg telecom', 'vodafone hutchison australia'],
    how: 'dial',
    numberFormat: 'international',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '**61*{number}#',
            when: 'Not answered',
          },
          {
            code: '**67*{number}#',
            when: 'Busy',
          },
          {
            code: '**62*{number}#',
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
            code: '**21*{number}#',
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
      'Only plans can forward to another number. Vodafone prepaid can forward only to voicemail or Call Catcher.',
      'Calls can’t be forwarded to 13, 1300 or 1800 numbers.',
      '##002# turns every kind of forwarding off. It can also be managed in My Vodafone.',
    ],
    sources: [VODAFONE_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'au-other-mobile',
    name: 'Another Australian mobile carrier',
    kind: 'mobile',
    countries: ['AU'],
    aliases: [
      'boost',
      'boost mobile',
      'aldi mobile',
      'amaysim',
      'belong',
      'felix',
      'felix mobile',
      'tpg mobile',
      'iinet mobile',
      'lebara',
      'kogan mobile',
      'woolworths mobile',
      'other',
      'mobile',
    ],
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
    note: 'Brands on Telstra, Optus or Vodafone’s network use the same GSM codes as those carriers. If a code is refused, use your phone’s call forwarding settings.',
    pitfalls: [
      'Many prepaid brands don’t allow forwarding to another number. If the code is refused, ask your provider or move to a plan.',
    ],
    sources: [GSM_STANDARD, TELSTRA_FORWARD_CALLS_ON, OPTUS_MANAGE_CALL_DIVERSIONS, VODAFONE_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'au-telstra-landline',
    name: 'Telstra home or business phone',
    kind: 'landline',
    countries: ['AU'],
    aliases: ['telstra landline', 'telstra home phone', 'telstra nbn phone', 'telstra business line', 'telstra voice'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61{number}#',
            when: 'Not answered',
          },
          {
            code: '*24{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#24#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21{number}#',
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
      'Lift the handset, wait for the dial tone, dial the code, then hang up.',
      'These are the codes for Telstra’s nbn home phone; mobile codes don’t work on the landline.',
      'It can also be set in the My Telstra app: your home phone › Call settings › Call forwarding.',
    ],
    sources: [
      {
        url: 'https://www.telstra.com.au/support/internet-and-home-phone/set-up-call-forwarding-on-home-phone',
        label: 'Telstra: forward calls on your home phone',
      },
    ],
  },
  {
    id: 'au-optus-landline',
    name: 'Optus home phone',
    kind: 'landline',
    countries: ['AU'],
    aliases: ['optus landline', 'optus home phone', 'optus nbn phone'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*78{number}',
          },
        ],
        off: [
          {
            code: '#78',
          },
        ],
      },
    },
    note: 'Optus documents only forwarding every call from the home phone. For missed calls only, ask Optus or forward every call.',
    pitfalls: [
      'Lift the handset, wait for the dial tone, dial the code. Two short beeps mean it worked.',
      'Only eligible Optus home phone services can forward.',
    ],
    sources: [
      {
        url: 'https://www.optus.com.au/support/answer/manage_home_phone_call_diversions_1428',
        label: 'Optus: manage home phone call diversions',
      },
    ],
  },
  {
    id: 'nz-one-nz',
    name: 'One NZ',
    kind: 'mobile',
    countries: ['NZ'],
    aliases: ['one nz', 'one new zealand', 'vodafone nz', 'vodafone new zealand'],
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
      'Prepay lines can’t forward; Pay Monthly (On Account) lines can, at no charge.',
      'One NZ can’t forward to international numbers.',
      'Missed calls ring for about 20 to 30 seconds before they forward.',
      'If ** doesn’t go through, leave a 2-second pause between the two * presses. ##002# turns all forwarding off.',
    ],
    sources: [ONE_NZ_SET_UP],
  },
  {
    id: 'nz-spark',
    name: 'Spark',
    kind: 'mobile',
    countries: ['NZ'],
    aliases: ['spark nz', 'spark new zealand', 'telecom nz', 'telecom new zealand', 'skinny'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}*11*20#',
            when: 'Not answered within 20 seconds',
          },
          {
            code: '*67*{number}*11#',
            when: 'Busy',
          },
          {
            code: '*62*{number}*11#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '#61**11#',
          },
          {
            code: '#67*11#',
          },
          {
            code: '#62*11#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}*11#',
          },
        ],
        off: [
          {
            code: '#21**11#',
          },
        ],
      },
    },
    check: [
      {
        code: '*#61*11#',
        when: 'Not answered',
      },
      {
        code: '*#21*11#',
        when: 'Every call',
      },
    ],
    pitfalls: [
      'Dial the codes from the phone itself and press Call after each.',
      'The ring time can be 5 to 25 seconds. Spark says iPhones can’t change it: on iPhone, use *61*{number}*11# without the 20.',
    ],
    sources: [SPARK_SET_UP_CALL],
  },
  {
    id: 'nz-2degrees',
    name: '2degrees',
    kind: 'mobile',
    countries: ['NZ'],
    aliases: ['2degrees mobile', 'two degrees', 'vocus'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: '2degrees publishes no forwarding codes for mobiles; it’s set in the phone’s call settings.',
    pitfalls: ['Forwarding to your own voicemail is the default for missed calls; turning on forwarding replaces it.'],
    sources: [
      {
        url: 'https://www.2degrees.nz/help/mobile-help/calling-features/voicemail-for-mobile',
        label: '2degrees: voicemail and conditional forwarding',
      },
      APPLE_SET_UP_CALL,
      SAMSUNG_AUSTRALIA_CALL_FORWARDING,
    ],
  },
  {
    id: 'nz-other-mobile',
    name: 'Another New Zealand mobile carrier',
    kind: 'mobile',
    countries: ['NZ'],
    aliases: ['warehouse mobile', 'kogan mobile nz', 'slingshot mobile', 'other', 'mobile'],
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
    note: 'Brands on One NZ, Spark or 2degrees’ networks usually take the standard GSM codes. If a code is refused, use your phone’s call forwarding settings.',
    pitfalls: ['Prepay lines often can’t forward to another number.'],
    sources: [GSM_STANDARD, ONE_NZ_SET_UP, SPARK_SET_UP_CALL],
  },
  {
    id: 'nz-spark-landline',
    name: 'Spark fibre or wireless landline',
    kind: 'landline',
    countries: ['NZ'],
    aliases: ['spark landline', 'spark home phone', 'spark fibre landline', 'spark business landline'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*16# {number}',
            when: 'Not answered',
          },
          {
            code: '*15# {number}',
            when: 'Busy',
          },
          {
            code: '*94# {number}',
            when: 'Phone off or no connection',
          },
        ],
        off: [
          {
            code: '#16#',
          },
          {
            code: '#15#',
          },
          {
            code: '#94#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*17# {number}',
          },
        ],
        off: [
          {
            code: '#17#',
          },
        ],
      },
    },
    pitfalls: [
      'Dial the code, then the number when asked.',
      'If * or # don’t work on your handset, use the number versions: 1416 (no answer), 1415 (busy), 1494 (off), 1417 (every call); 1516, 1515, 1594, 1517 turn them off.',
      'These are for Spark’s fibre and wireless landlines; old copper lines use slot codes (181…).',
    ],
    sources: [
      {
        url: 'https://www.spark.co.nz/help/landline/manage/fibre-and-wireless-call-features/',
        label: 'Spark: fibre and wireless landline features',
      },
    ],
  },
  {
    id: 'nz-copper-business-line',
    name: 'Copper business landline (Spark or One NZ)',
    kind: 'landline',
    countries: ['NZ'],
    aliases: ['spark copper', 'one nz landline', 'one nz business landline', 'vodafone nz landline', 'chorus copper'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '181161{number}#',
            when: 'Saves the number in slot 161 (a long-short-long tone means saved); then dial 161 to turn diversion on',
          },
        ],
        off: [
          {
            code: '160',
          },
        ],
      },
    },
    note: 'Call Diversion on copper lines is a paid feature set up by Spark or One NZ, and they decide which calls it diverts (every call, busy, or no answer). Ask them for no-answer diversion.',
    pitfalls: [
      'Lift the handset and wait for the dial tone before each code.',
      'While diversion is on, the dial tone sounds long-short-long.',
      'Copper lines are being retired; on a fibre landline use the fibre codes instead.',
    ],
    sources: [
      {
        url: 'https://www.spark.co.nz/business/help/voice/call-diversion/',
        label: 'Spark Business: call diversion',
      },
      {
        url: 'https://one.nz/faq/call-diversion-on-a-business-landline',
        label: 'One NZ: call diversion on a copper business landline',
      },
    ],
  },
  {
    id: 'in-vi',
    name: 'Vi (Vodafone Idea)',
    kind: 'mobile',
    countries: ['IN'],
    aliases: ['vi', 'vodafone idea', 'vodafone india', 'idea cellular', 'idea'],
    how: 'dial',
    numberFormat: 'nsn',
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
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
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
            code: '##21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      '##002# turns every kind of forwarding off.',
    ],
    sources: [VI_ACTIVATE_AND_DEACTIVATE],
  },
  {
    id: 'in-airtel',
    name: 'Airtel',
    kind: 'mobile',
    countries: ['IN'],
    aliases: ['bharti airtel', 'airtel india', 'airtel thanks'],
    how: 'dial',
    numberFormat: 'nsn',
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
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
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
            code: '##21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    pitfalls: [
      'Airtel documents the every-call code; the missed-call codes are the standard GSM ones Vi documents for India. The check shows whether they took.',
      'It can also be set in the Airtel Thanks app: call settings › call forwarding.',
    ],
    sources: [
      {
        url: 'https://www.airtel.in/blog/airtel-app/activate-and-deactivate-call-forwarding-in-airtel/',
        label: 'Airtel: activate and deactivate call forwarding',
      },
      VI_ACTIVATE_AND_DEACTIVATE,
      GSM_STANDARD,
    ],
  },
  {
    id: 'in-jio',
    name: 'Jio',
    kind: 'mobile',
    countries: ['IN'],
    aliases: ['reliance jio', 'jio mobile', 'jio true 5g'],
    domesticOnly: true,
    how: 'settings',
    where: 'the MyJio app',
    modes: {
      forward_conditional: {
        on: [
          'MyJio › Profile › Mobile Settings › Service Settings › Call Forwarding › Voice.',
          'Choose “When unanswered” and complete the SIM verification.',
          'Enter {number} (10 digits) › Continue. Do the same for “When busy” and “When unreachable”.',
        ],
        off: ['Turn the forwarding types off in the same place.'],
      },
      forward_all: {
        on: [
          'MyJio › Profile › Mobile Settings › Service Settings › Call Forwarding › Voice.',
          'Choose “Always” (unconditional) and complete the SIM verification.',
          'Enter {number} (10 digits) › Continue.',
        ],
        off: ['Turn it off in the same place.'],
      },
    },
    check: 'MyJio › Profile › Mobile Settings › Service Settings › Call Forwarding',
    note: 'Jio documents forwarding in the MyJio app and in the phone’s call settings (Settings › Call › Advanced settings › Call forwarding).',
    pitfalls: [
      'Jio can’t forward to BSNL numbers or international numbers: your assistant needs an Indian number on another network.',
      'Forwarding is free but needs an active plan.',
    ],
    sources: [
      {
        url: 'https://www.jio.com/help/faq/mobile/services/hd-voice/how-can-i-activate-call-forwarding-service/',
        label: 'Jio: how to activate call forwarding',
      },
      {
        url: 'https://www.jio.com/help/faq/mobile/services/hd-voice/what-are-different-types-of-call-forwarding',
        label: 'Jio: types of call forwarding',
      },
    ],
  },
  {
    id: 'in-other-mobile',
    name: 'Another Indian mobile carrier',
    kind: 'mobile',
    countries: ['IN'],
    aliases: ['bsnl', 'bsnl mobile', 'mtnl', 'other', 'mobile'],
    how: 'dial',
    numberFormat: 'nsn',
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
          {
            code: '*62*{number}#',
            when: 'Phone off or no signal',
          },
        ],
        off: [
          {
            code: '##61#',
          },
          {
            code: '##67#',
          },
          {
            code: '##62#',
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
            code: '##21#',
          },
        ],
      },
    },
    check: GSM_CHECK,
    note: 'These are the standard GSM codes Vi documents for India. If a code is refused, use your phone’s call forwarding settings.',
    pitfalls: ['BSNL publishes no code list we could verify; the check (*#61#) shows whether the code took.'],
    sources: [GSM_STANDARD, VI_ACTIVATE_AND_DEACTIVATE],
  },
  {
    id: 'in-jiofiber-voice',
    name: 'JioFiber landline (JioFiberVoice)',
    kind: 'landline',
    countries: ['IN'],
    aliases: ['jiofiber', 'jio fiber', 'jiofibervoice', 'jio landline', 'jio home phone'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*403*{number}',
            when: 'Not answered',
          },
          {
            code: '*405*{number}',
            when: 'Busy',
          },
          {
            code: '*409*{number}',
            when: 'Not reachable',
          },
        ],
        off: [
          {
            code: '*404',
          },
          {
            code: '*406',
          },
          {
            code: '*410',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*401*{number}',
          },
        ],
        off: [
          {
            code: '*402',
          },
        ],
      },
    },
    pitfalls: [
      'Dial from the JioFiber landline (or a phone connected to it).',
      '*413 turns all forwarding off at once.',
    ],
    sources: [
      {
        url: 'https://www.jio.com/help/faq/jiofiber/services/jiofibervoice/can-i-activate-call-forwarding-facility-on-my-jiofibervoice-number/',
        label: 'Jio: call forwarding on JioFiberVoice',
      },
    ],
  },
  {
    id: 'sg-singtel',
    name: 'Singtel',
    kind: 'mobile',
    countries: ['SG'],
    aliases: ['singtel mobile', 'singapore telecommunications', 'gomo', 'singtel business'],
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
      'Dial the codes from the phone itself.',
      'To let it ring longer before forwarding, Singtel documents **61*{number}*11*30# (30 seconds).',
      'Overseas, forwarding can only be turned on or off.',
    ],
    sources: [SINGTEL_MANAGE_CALL_DIVERSIONS, GSM_STANDARD],
  },
  {
    id: 'sg-starhub',
    name: 'StarHub',
    kind: 'mobile',
    countries: ['SG'],
    aliases: ['starhub mobile', 'giga'],
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
    pitfalls: ['Dial the codes from the phone itself and press Call after each.'],
    sources: [STARHUB_MOBILE_SHORT_CODES, GSM_STANDARD],
  },
  {
    id: 'sg-m1',
    name: 'M1',
    kind: 'mobile',
    countries: ['SG'],
    aliases: ['m1 limited', 'm1 mobile', 'mobileone'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'M1 publishes no forwarding codes for mobiles; it’s set in the phone’s call settings.',
    pitfalls: ['If the setting is refused, ask M1 to allow call forwarding on the line.'],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'sg-other-mobile',
    name: 'Another Singapore mobile carrier',
    kind: 'mobile',
    countries: ['SG'],
    aliases: [
      'simba',
      'tpg singapore',
      'circles.life',
      'circles life',
      'myrepublic mobile',
      'zero1',
      'other',
      'mobile',
    ],
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
    note: 'Brands on Singtel, StarHub, M1 or Simba’s networks usually take the standard GSM codes. If a code is refused, use your phone’s call forwarding settings.',
    pitfalls: [],
    sources: [GSM_STANDARD, SINGTEL_MANAGE_CALL_DIVERSIONS, STARHUB_MOBILE_SHORT_CODES],
  },
  {
    id: 'sg-m1-digital-voice',
    name: 'M1 Digital Voice (business line)',
    kind: 'landline',
    countries: ['SG'],
    aliases: ['m1 digital voice', 'm1 business line', 'm1 fixed line'],
    domesticOnly: true,
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
          {
            code: '*47*{number}#',
            when: 'Line not reachable',
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
            code: '#47#',
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
      'Forwards only to Singapore numbers (6xxx xxxx or 9xxx xxxx); international numbers aren’t supported.',
      'Busy calls still ring through if Call Waiting is on.',
    ],
    sources: [
      {
        url: 'https://www.m1.com.sg/content/dam/M1/nov-2023/business/products/telephony/digital-voice.pdf',
        label: 'M1 Digital Voice user guide (PDF)',
      },
    ],
  },
  {
    id: 'jp-docomo',
    name: 'NTT docomo',
    kind: 'mobile',
    countries: ['JP'],
    aliases: ['docomo', 'ntt docomo', 'ドコモ', 'エヌ・ティ・ティ・ドコモ'],
    how: 'dial',
    numberFormat: 'national',
    ringSeconds: 20,
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*120*1*{number}*20#',
            when: 'Not answered within 20 seconds, phone off or no signal',
          },
        ],
        off: [
          {
            code: '#120*1#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*120*1*{number}*0#',
            when: 'Ring time 0: forwards straight away',
          },
        ],
        off: [
          {
            code: '#120*1#',
          },
        ],
      },
    },
    check: [
      {
        code: '1429',
        when: 'Then press 4 to hear the settings',
      },
    ],
    pitfalls: [
      'Order 転送でんわサービス first (free, in My docomo); it starts switched off. It isn’t available on ahamo.',
      'On iPhone, Live Voicemail answers first unless the ring time is under 12 seconds: turn it off (Settings › Apps › Phone › Live Voicemail).',
      'On Google Pixel, turn off Call Screen, or forwarding may not work.',
      'You pay for the forwarded part of the call.',
      'Phones sold from October 2024 and Android 15 can’t set it in the phone’s menu; use the code.',
    ],
    sources: [
      {
        url: 'https://www.docomo.ne.jp/service/transfer/usage/',
        label: 'docomo: 転送でんわサービス 操作・設定方法',
      },
      DOCOMO,
      {
        url: 'https://www.docomo.ne.jp/service/transfer/',
        label: 'docomo: 転送でんわサービス',
      },
    ],
  },
  {
    id: 'jp-au',
    name: 'au (KDDI)',
    kind: 'mobile',
    countries: ['JP'],
    aliases: ['au', 'kddi', 'au by kddi', 'エーユー'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '1422{number}',
            when: 'Busy or not answered',
          },
        ],
        off: [
          {
            code: '1420',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '1424{number}',
          },
        ],
        off: [
          {
            code: '1420',
          },
        ],
      },
    },
    pitfalls: [
      'Missed calls ring for 24 seconds before they forward. 1418 plus the seconds (05 to 55) changes it, e.g. 141820 for 20 seconds.',
      'On iPhone, Live Voicemail stops no-answer forwarding: turn it off (Settings › Apps › Phone › Live Voicemail) or set 12 seconds or less.',
      'Turning forwarding on stops お留守番サービスEX, and 1420 stops both.',
      'An iPhone may show “接続できませんでした” after the code. It still worked.',
      'You pay for the forwarded part of the call.',
    ],
    sources: [
      {
        url: 'https://www.au.com/mobile/service/tensou/',
        label: 'au: 着信転送サービス',
      },
    ],
  },
  {
    id: 'jp-softbank',
    name: 'SoftBank',
    kind: 'mobile',
    countries: ['JP'],
    aliases: ['softbank', 'softbank mobile', 'ソフトバンク'],
    domesticOnly: true,
    how: 'settings',
    where: 'My SoftBank',
    modes: {
      forward_conditional: {
        on: [
          'Sign in to My SoftBank › 転送電話サービス.',
          'Check “指定の電話番号に転送” and enter {number}.',
          'Choose a ring time (about 20 seconds) › 次へ › 設定.',
        ],
        off: ['My SoftBank › 転送電話サービス › “転送しない” › 次へ › 設定.'],
      },
    },
    check: 'My SoftBank › 転送電話サービス',
    note: 'SoftBank’s 転送電話 rings your phone first, then forwards; calls forward straight away when the phone is off or out of range. On VoLTE, SoftBank asks you to set it in the phone itself.',
    pitfalls: [
      '転送電話 and 留守番電話 can’t be on together.',
      'It can’t forward to overseas numbers.',
      'The old 1406 codes stopped working in April 2022.',
      'You pay for the forwarded part of the call.',
    ],
    sources: [
      {
        url: 'https://www.softbank.jp/support/faq/view/10112',
        label: 'SoftBank: 転送電話の設定方法',
      },
      {
        url: 'https://www.softbank.jp/support/faq/view/10111',
        label: 'SoftBank: 転送電話のサービス内容',
      },
    ],
  },
  {
    id: 'jp-rakuten',
    name: 'Rakuten Mobile',
    kind: 'mobile',
    countries: ['JP'],
    aliases: ['rakuten', 'rakuten mobile', '楽天モバイル'],
    domesticOnly: true,
    how: 'settings',
    where: 'my 楽天モバイル',
    modes: {
      forward_conditional: {
        on: [
          'Turn 留守番電話 off first: the two can’t be on together.',
          'my 楽天モバイル › 契約プラン › プランに含まれるオプションサービス › 着信転送.',
          'Turn on 無応答時転送 (no answer), enter {number} and a ring time. Turn on 話中時転送 and 圏外時転送 with {number} too.',
          '変更する.',
        ],
        off: ['Turn 着信転送 off in the same place.'],
      },
      forward_all: {
        on: [
          'my 楽天モバイル › 契約プラン › プランに含まれるオプションサービス › 着信転送.',
          'Turn on 無条件転送 and enter {number} › 変更する.',
        ],
        off: ['Turn 着信転送 off in the same place.'],
      },
    },
    check: 'my 楽天モバイル › 契約プラン › 着信転送',
    pitfalls: ['Forwarded calls cost 22 yen per 30 seconds.', 'It can’t forward to overseas numbers.'],
    sources: [
      {
        url: 'https://network.mobile.rakuten.co.jp/guide/call-forwarding/',
        label: 'Rakuten Mobile: 着信転送 ご利用方法',
      },
    ],
  },
  {
    id: 'jp-other-mobile',
    name: 'Another Japanese mobile carrier',
    kind: 'mobile',
    countries: ['JP'],
    aliases: ['uq mobile', 'y!mobile', 'ymobile', 'povo', 'linemo', 'ahamo', 'mvno', 'other', 'mobile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Japanese carriers use their own forwarding services, not standard codes. Check whether your plan includes call forwarding, then set it in the phone or your carrier’s app.',
    pitfalls: ['Some plans don’t include forwarding at all (docomo’s ahamo, for example).'],
    sources: [APPLE_SET_UP_CALL, DOCOMO],
  },
  {
    id: 'jp-ntt-voicewarp',
    name: 'NTT ひかり電話 / 加入電話 (ボイスワープ)',
    kind: 'landline',
    countries: ['JP'],
    aliases: [
      'ntt',
      'ntt east',
      'ntt west',
      'ntt東日本',
      'ntt西日本',
      'ひかり電話',
      'hikari denwa',
      'voice warp',
      'ボイスワープ',
    ],
    how: 'settings',
    where: 'the ひかり電話設定サイト (NTT East: hikari.ntt-east.net)',
    modes: {
      forward_conditional: {
        on: [
          'Order ボイスワープ for the line from NTT first.',
          'Sign in to the ひかり電話設定サイト › ボイスワープ.',
          'Enter {number} as the forwarding number.',
          'Choose 無応答時転送・話中時転送 (no answer and busy) with a ring time of about 20 seconds, and start it.',
        ],
        off: ['Stop ボイスワープ in the same place.'],
      },
      forward_all: {
        on: [
          'Sign in to the ひかり電話設定サイト › ボイスワープ.',
          'Enter {number} and choose 無条件転送 (every call), then start it.',
        ],
        off: ['Stop ボイスワープ in the same place.'],
      },
    },
    note: 'ボイスワープ can also be set from the phone on the line by following NTT’s voice guidance; NTT’s operation guide has the menu numbers.',
    pitfalls: [
      'You pay for the forwarded part of the call.',
      'If the line or router is down, only 無条件転送 keeps forwarding.',
    ],
    sources: [
      {
        url: 'https://business.ntt-east.co.jp/support/hikari_of/',
        label: 'NTT東日本: ひかり電話オフィスタイプ サポート',
      },
      {
        url: 'https://business.ntt-east.co.jp/service/hikari_of/download/voice.pdf',
        label: 'NTT東日本: ボイスワープ ご利用ガイド (PDF)',
      },
    ],
  },
  {
    id: 'ph-globe',
    name: 'Globe',
    kind: 'mobile',
    countries: ['PH'],
    aliases: ['globe telecom', 'globe mobile', 'tm', 'touch mobile', 'gomo ph'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Globe publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_PHILIPPINES_CALL_FORWARDING],
  },
  {
    id: 'ph-smart',
    name: 'Smart',
    kind: 'mobile',
    countries: ['PH'],
    aliases: ['smart communications', 'smart mobile', 'tnt', 'talk n text', 'sun cellular'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Smart publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_PHILIPPINES_CALL_FORWARDING],
  },
  {
    id: 'ph-dito',
    name: 'DITO',
    kind: 'mobile',
    countries: ['PH'],
    aliases: ['dito telecommunity', 'dito mobile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'DITO publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_PHILIPPINES_CALL_FORWARDING],
  },
  {
    id: 'ph-other-mobile',
    name: 'Another Philippine mobile carrier',
    kind: 'mobile',
    countries: ['PH'],
    aliases: ['other', 'mobile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_PHILIPPINES_CALL_FORWARDING],
  },
  {
    id: 'ph-pldt',
    name: 'PLDT landline',
    kind: 'landline',
    countries: ['PH'],
    aliases: ['pldt', 'pldt home', 'pldt landline', 'philippine long distance telephone'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*04*{number}#',
            when: 'Not answered after 4 rings',
          },
          {
            code: '*07*{number}#',
            when: 'Busy',
          },
        ],
        off: [],
      },
      forward_all: {
        on: [
          {
            code: '*21*{number}#',
          },
        ],
        off: [],
      },
    },
    note: 'PLDT doesn’t publish codes to turn forwarding off; ask PLDT to switch it off when you no longer need it.',
    pitfalls: [
      'Call Forwarding must be activated first: myPLDT Smart app › Help Ticket › Aftersales › Feature Activation (one-time and monthly fee of 50 pesos, ready within 24 to 48 hours).',
      'Forwarded calls are charged to your account; calls to mobiles cost 14 pesos per minute.',
    ],
    sources: [
      {
        url: 'https://www.pldthome.com/support-landline-call-forwarding',
        label: 'PLDT: landline call forwarding',
      },
    ],
  },
  {
    id: 'za-vodacom',
    name: 'Vodacom',
    kind: 'mobile',
    countries: ['ZA'],
    aliases: ['vodacom south africa', 'vodacom sa'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Vodacom publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line (some prepaid lines can’t forward).',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'za-mtn',
    name: 'MTN',
    kind: 'mobile',
    countries: ['ZA'],
    aliases: ['mtn south africa', 'mtn sa'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'MTN publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line (some prepaid lines can’t forward).',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'za-cell-c',
    name: 'Cell C',
    kind: 'mobile',
    countries: ['ZA'],
    aliases: ['cellc', 'cell c south africa'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Cell C publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line (some prepaid lines can’t forward).',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'za-telkom-mobile',
    name: 'Telkom Mobile',
    kind: 'mobile',
    countries: ['ZA'],
    aliases: ['telkom mobile', '8ta'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Telkom Mobile publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding on the line (some prepaid lines can’t forward).',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'za-other-mobile',
    name: 'Another South African mobile carrier',
    kind: 'mobile',
    countries: ['ZA'],
    aliases: ['rain', 'mvno', 'other', 'mobile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'za-telkom-landline',
    name: 'Telkom landline (ForwardCall)',
    kind: 'landline',
    countries: ['ZA'],
    aliases: ['telkom', 'telkom landline', 'telkom business', 'forwardcall', 'openserve'],
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
    note: 'Telkom documents only forwarding every call from the landline.',
    pitfalls: [
      'Lift the handset, wait for the dial tone, dial the code and wait for the acknowledgement tone.',
      'You pay for the forwarded part of the call; the caller pays for the call to your line.',
    ],
    sources: [
      {
        url: 'https://group.telkom.co.za/documents/regulatory/terms-and-conditions/Telkom-Business-Forward-Call.pdf',
        label: 'Telkom Business: ForwardCall (PDF)',
      },
    ],
  },
  {
    id: 'ae-eand',
    name: 'e& (Etisalat)',
    kind: 'mobile',
    countries: ['AE'],
    aliases: ['etisalat', 'e&', 'eand', 'etisalat uae', 'emirates telecommunications'],
    domesticOnly: true,
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
    check: GSM_CHECK,
    pitfalls: [
      'Forwards only to UAE mobile or landline numbers: your assistant needs a UAE number.',
      'Forwarding is free; forwarded calls cost the local call rate.',
    ],
    sources: [E_UAE_MOBILE_VALUE, GSM_STANDARD],
  },
  {
    id: 'ae-du',
    name: 'du',
    kind: 'mobile',
    countries: ['AE'],
    aliases: ['du', 'emirates integrated telecommunications', 'eitc', 'virgin mobile uae', 'virgin mobile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'du publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: ['Forwarded calls are charged like a call you make.'],
    sources: [
      APPLE_SET_UP_CALL,
      {
        url: 'https://www.samsung.com/ae/support/mobile-devices/enable-or-disable-call-forwarding-on-samsung-galaxy/',
        label: 'Samsung Gulf: call forwarding on Galaxy phones',
      },
    ],
  },
  {
    id: 'ae-other-mobile',
    name: 'Another UAE mobile carrier',
    kind: 'mobile',
    countries: ['AE'],
    aliases: ['other', 'mobile'],
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
    check: GSM_CHECK,
    note: 'These are the standard GSM codes e& documents for the UAE. If a code is refused, use your phone’s call forwarding settings.',
    pitfalls: [],
    sources: [GSM_STANDARD, E_UAE_MOBILE_VALUE],
  },
  {
    id: 'ae-eand-landline',
    name: 'e& home or business landline',
    kind: 'landline',
    countries: ['AE'],
    aliases: ['etisalat landline', 'etisalat home phone', 'elife phone', 'e& landline'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered after a set number of rings',
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
      'The forwarding codes come with e&’s Call Plus Bundle for the home phone (AED 2.86 a month plus VAT).',
      'Dial from the landline itself.',
    ],
    sources: [
      {
        url: 'https://www.eand.ae/en/c/home/call-plus-bundle.html',
        label: 'e& UAE: Call Plus Bundle (home phone features)',
      },
    ],
  },
  {
    id: 'il-cellcom',
    name: 'Cellcom',
    kind: 'mobile',
    countries: ['IL'],
    aliases: ['cellcom israel', 'סלקום'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Cellcom publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding (עקוב אחרי) on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'il-partner',
    name: 'Partner',
    kind: 'mobile',
    countries: ['IL'],
    aliases: ['partner communications', 'orange israel', 'פרטנר'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Partner publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding (עקוב אחרי) on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'il-pelephone',
    name: 'Pelephone',
    kind: 'mobile',
    countries: ['IL'],
    aliases: ['pelephone', 'פלאפון'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Pelephone publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding (עקוב אחרי) on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'il-hot-mobile',
    name: 'HOT Mobile',
    kind: 'mobile',
    countries: ['IL'],
    aliases: ['hot mobile', 'הוט מובייל'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'HOT Mobile publishes no forwarding codes we could verify; it’s set in the phone’s call settings.',
    pitfalls: [
      'If the setting is refused, ask your carrier to allow call forwarding (עקוב אחרי) on the line.',
      'Forwarded calls are charged like a call you make.',
    ],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
  {
    id: 'il-other-mobile',
    name: 'Another Israeli mobile carrier',
    kind: 'mobile',
    countries: ['IL'],
    aliases: ['golan telecom', 'we4g', '019 mobile', 'rami levy', 'other', 'mobile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: galaxyMenuModes,
    note: 'Set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_SET_UP_CALL, SAMSUNG_AUSTRALIA_CALL_FORWARDING],
  },
]
