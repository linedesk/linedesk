// Forwarding guides for Canada, Mexico, Brazil, Argentina, Chile and Colombia (researched 15.11.2026).
// Sourcing rule and fields: see ../forwarding-guides.ts and ./shared.ts.
import { APPLE_CALL_FORWARDING, type ForwardingGuide, GSM_CHECK, GSM_STANDARD, phoneMenuModes } from './shared.ts'

const ROGERS_CALL_FORWARDING_CODES = {
  url: 'https://www.rogers.com/customer/support/article/what-are-the-codes-for-call-forwarding-for-my-wireless-device',
  label: 'Rogers: call forwarding codes for your wireless device',
}
const FREEDOM_MOBILE_CALL_CONTROL = {
  url: 'https://www.freedommobile.ca/en-CA/support/about-call-control',
  label: 'Freedom Mobile: call control',
}
const SAMSUNG_CALL_FORWARDING_ON = {
  url: 'https://www.samsung.com/sa_en/support/mobile-devices/how-to-enable-or-disable-the-call-forwarding-feature-in-your-samsung-galaxy-smartphone/',
  label: 'Samsung: call forwarding on Galaxy phones',
}
const CLARO_COLOMBIA_DESVIO_DE = {
  url: 'https://www.claro.com.co/institucional/fraude-desvio-de-llamadas/',
  label: 'Claro Colombia: desvío de llamadas, riesgos y restricciones',
}

export const americasGuides: readonly ForwardingGuide[] = [
  {
    id: 'ca-rogers',
    name: 'Rogers',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['rogers wireless', 'rogers communications', 'rogers mobility', 'chatr'],
    how: 'dial',
    numberFormat: 'ten',
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
      'Rogers: missed-call forwarding doesn’t work while Rogers voicemail is on. Ask Rogers to remove voicemail from the line first.',
      'To change the number, cancel the old forwarding (##21#, ##61# …) before setting the new one.',
    ],
    sources: [
      ROGERS_CALL_FORWARDING_CODES,
      {
        url: 'https://www.rogers.com/support/mobility/use-call-forwarding',
        label: 'Rogers: use call forwarding',
      },
    ],
  },
  {
    id: 'ca-fido',
    name: 'Fido',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['fido solutions', 'fido mobile'],
    network: 'Rogers',
    how: 'dial',
    numberFormat: 'ten',
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
    pitfalls: [
      'Missed-call forwarding only works on lines without Fido Voice Messaging.',
      'Unanswered calls forward after about 20 seconds.',
      'Forwarded minutes are billed pay-per-use unless you add the Call Forwarding add-on; they never use your plan minutes.',
      'Only Canadian and US numbers.',
    ],
    sources: [
      {
        url: 'https://www.fido.ca/support/mobility/call-forwarding',
        label: 'Fido: call forwarding',
      },
    ],
  },
  {
    id: 'ca-freedom',
    name: 'Freedom Mobile',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['freedom', 'wind mobile', 'wind'],
    domesticOnly: true,
    how: 'dial',
    numberFormat: 'ten',
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
    pitfalls: [
      'Dial the codes from the phone itself.',
      'Forwarding within Canada is free on Freedom; only Canadian numbers.',
      'On iPhone the Settings menu only forwards every call; use the codes for missed calls.',
    ],
    sources: [FREEDOM_MOBILE_CALL_CONTROL],
  },
  {
    id: 'ca-telus',
    name: 'TELUS',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['telus mobility', 'telus communications', 'telus business'],
    how: 'dial',
    numberFormat: 'ten',
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
    pitfalls: [
      'Call forwarding must be on your plan (Call Forwarding North America: 3,000 minutes a month, 75¢ per extra minute); otherwise minutes are billed pay-per-use.',
      'Not available on TELUS Prepaid.',
      'TELUS says only every-call forwarding works on every phone; the missed-call codes depend on the phone. Check it: let a call ring out and see that it reaches your assistant.',
      'To choose the ring time instead, dial *004*, your assistant’s number, *20# (10, 20 or 30 seconds). #004# turns it off.',
    ],
    sources: [
      {
        url: 'https://www.telus.com/en/support/article/call-forward-mobile',
        label: 'TELUS: call forwarding on your mobile device',
      },
      {
        url: 'https://www.telus.com/business/support/article/call-forward-mobile',
        label: 'TELUS Business: call forwarding on your mobile',
      },
    ],
  },
  {
    id: 'ca-koodo',
    name: 'Koodo',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['koodo mobile'],
    network: 'TELUS',
    how: 'dial',
    numberFormat: 'ten',
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
    pitfalls: [
      'Add Call Forwarding first ($5/month): Self Serve › Mobile services › Manage add-ons.',
      'Prepaid lines can only forward when the phone is off or has no signal (*62*).',
    ],
    sources: [
      {
        url: 'https://www.koodomobile.com/en/help/call-forwarding',
        label: 'Koodo: call forwarding',
      },
    ],
  },
  {
    id: 'ca-public-mobile',
    name: 'Public Mobile',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['public mobile', 'publicmobile'],
    network: 'TELUS',
    how: 'dial',
    numberFormat: 'ten',
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
    pitfalls: [
      'Dial the codes from the phone itself, then press Call.',
      'To choose the ring time instead, Public Mobile documents *004*, your assistant’s number, **, the seconds, #. #004# turns it off.',
    ],
    sources: [
      {
        url: 'https://www.publicmobile.ca/en/get-help/articles/call-forwarding',
        label: 'Public Mobile: how to set up call forwarding',
      },
    ],
  },
  {
    id: 'ca-bell',
    name: 'Bell Mobility',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['bell', 'bell canada', 'bell mobility', 'lucky mobile', 'lucky'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Bell publishes no forwarding codes; it’s set in the phone’s call settings. A text confirms it.',
    pitfalls: [
      'Without the Call Forwarding add-on, forwarded calls cost $0.25 a minute.',
      'Bell’s “No Answer Transfer” (ring first, then forward) is a separate service: ask Bell if missed-call forwarding is refused.',
      'To get your voicemail back later, choose “Deactivate All” in the phone’s forwarding menu.',
    ],
    sources: [
      {
        url: 'https://support.bell.ca/mobility/rate_plans_features/how_to_use_call_forwarding_on_my_mobile_phone',
        label: 'Bell: call forwarding on your mobile',
      },
      APPLE_CALL_FORWARDING,
      SAMSUNG_CALL_FORWARDING_ON,
    ],
  },
  {
    id: 'ca-virgin-plus',
    name: 'Virgin Plus',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['virgin mobile canada', 'virgin plus', 'virgin mobile'],
    network: 'Bell',
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Virgin Plus publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: ['Call Forwarding is a $6/month add-on; add it in My Account first.'],
    sources: [
      {
        url: 'https://virginplus.ca/en/features/index.html',
        label: 'Virgin Plus: add-on features',
      },
      APPLE_CALL_FORWARDING,
      SAMSUNG_CALL_FORWARDING_ON,
    ],
  },
  {
    id: 'ca-videotron',
    name: 'Vidéotron',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['videotron', 'vidéotron mobile', 'fizz'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Vidéotron documents forwarding in the phone’s call settings, not with codes.',
    pitfalls: [
      'The phone and SIM must support VoLTE to turn forwarding on or change it.',
      'Without the Mobile Call Forwarding option, each forwarded minute costs $0.75.',
      'Only Canadian and US numbers.',
      'To get voicemail back later, set busy, unanswered and unreachable forwarding to 1-514-424-2302.',
    ],
    sources: [
      {
        url: 'https://www.videotron.com/en/support/mobile/calls-and-messaging/call-forwarding',
        label: 'Vidéotron: call forwarding on mobile',
      },
    ],
  },
  {
    id: 'ca-other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['CA'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'dial',
    numberFormat: 'ten',
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
    note: 'The standard GSM codes, as Rogers, Freedom and TELUS document them.',
    pitfalls: [
      'These are the standard codes Canadian carriers use. If one is refused, use the phone’s call forwarding settings instead.',
      'Many Canadian carriers charge for forwarded minutes unless call forwarding is on the plan.',
    ],
    sources: [GSM_STANDARD, ROGERS_CALL_FORWARDING_CODES, FREEDOM_MOBILE_CALL_CONTROL],
  },
  {
    id: 'ca-bell-business-line',
    name: 'Bell business landline',
    kind: 'landline',
    countries: ['CA'],
    aliases: ['bell business', 'bell home phone', 'bell local link', 'bell canada landline', 'bell aliant'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*92{number}',
            when: 'Not answered after 4 rings',
          },
          {
            code: '*90 {number}',
            when: 'Busy (dial *90, wait for the prompt, then the number)',
          },
        ],
        off: [
          {
            code: '*93',
          },
          {
            code: '*91',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    pitfalls: [
      'Dial from the business line itself; two beeps mean it’s on.',
      'Busy forwarding only works on Local Link without voicemail or with programmable voicemail.',
      'If the line has Bell voicemail set up by Bell, missed calls keep going to voicemail: ask Bell to change it.',
    ],
    sources: [
      {
        url: 'https://business.bell.ca/Support/small-business/phone/calling-features/how-to-use-call-forwarding',
        label: 'Bell Business: how to use call forwarding',
      },
    ],
  },
  {
    id: 'ca-telus-home-phone',
    name: 'TELUS Home Phone',
    kind: 'landline',
    countries: ['CA'],
    aliases: ['telus home phone', 'telus landline', 'telus business phone'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    note: 'TELUS sets busy and no-answer forwarding to a fixed number itself; new accounts can’t change it. Forward every call, or ask TELUS.',
    pitfalls: [
      'Dial *72, wait for 3 beeps and a dial tone, then the number. Someone must answer at the assistant’s number: it does.',
      'Long distance charges apply if the assistant’s number is long distance.',
    ],
    sources: [
      {
        url: 'https://www.telus.com/en/support/article/use-call-forwarding-variable',
        label: 'TELUS: Call Forward for your home phone',
      },
    ],
  },
  {
    id: 'ca-rogers-home-phone',
    name: 'Rogers Home Phone',
    kind: 'landline',
    countries: ['CA'],
    aliases: ['rogers home phone', 'rogers ignite home phone', 'shaw home phone', 'shaw'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*92{number}',
            when: 'Not answered after 4 rings',
          },
        ],
        off: [
          {
            code: '*93',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    pitfalls: [
      'Stay on the line at least 5 seconds after the assistant answers, or forwarding won’t turn on.',
      'With Rogers voicemail, *92 only switches voicemail. Remove voicemail first to forward missed calls.',
      'Only one call is forwarded at a time; a second caller gets a busy signal.',
      'If the assistant’s number is long distance from your line, put 1 in front of it.',
    ],
    sources: [
      {
        url: 'https://www.rogers.com/support/home-phone/call-forwarding',
        label: 'Rogers Home Phone: call forwarding',
      },
      {
        url: 'https://www.rogers.com/support/home-phone/forward-calls-when-no-answer',
        label: 'Rogers Home Phone: forward calls when there’s no answer',
      },
    ],
  },
  {
    id: 'ca-rogers-business-phone',
    name: 'Rogers Business Phone (IBLc)',
    kind: 'landline',
    countries: ['CA'],
    aliases: ['rogers business', 'iblc', 'rogers business phone'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    note: 'Rogers documents forwarding every call; missed-call forwarding (“Enhanced Call Forward”) is ordered from Rogers.',
    pitfalls: [
      'Stay on the line at least 5 seconds after the assistant answers, or forwarding won’t turn on.',
      'Dial *72 again to check: a busy tone means forwarding is on.',
      'Not available on lines in a hunt group. With Business Voicemail it can’t forward only missed calls.',
      'It can also be set in Business Online Manager › Forwarding.',
    ],
    sources: [
      {
        url: 'https://www.rogers.com/business/support/business-phone/iblc-call-forward',
        label: 'Rogers Business: IBLc Call Forward',
      },
    ],
  },
  {
    id: 'ca-cogeco',
    name: 'Cogeco Home Phone',
    kind: 'landline',
    countries: ['CA'],
    aliases: ['cogeco', 'cogeco business'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    note: 'Cogeco documents forwarding every call only.',
    pitfalls: [
      'Call Forwarding must be on your account first.',
      'Dial *72, wait for the stutter tone, then the 10-digit number.',
    ],
    sources: [
      {
        url: 'https://help.cogeco.ca/article/how-do-i-configure-my-call-forwarding-service-1468',
        label: 'Cogeco: configure Call Forwarding (*72)',
      },
    ],
  },
  {
    id: 'mx-telcel',
    name: 'Telcel',
    kind: 'mobile',
    countries: ['MX'],
    aliases: ['radiomovil dipsa', 'telcel'],
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
    note: 'Telcel only documents forwarding every call. For missed calls only, use the phone’s call forwarding settings (When unanswered / busy / unreachable).',
    pitfalls: [
      'Dial from the Telcel phone itself, with the 10-digit number.',
      'Forwarded calls are charged like a call from your line to that number.',
    ],
    sources: [
      {
        url: 'https://www.telcel.com/personas/servicios/llamadas-y-mensajeria/llamadas',
        label: 'Telcel: transferencia de llamadas',
      },
    ],
  },
  {
    id: 'mx-att',
    name: 'AT&T México',
    kind: 'mobile',
    countries: ['MX'],
    aliases: ['at&t mexico', 'att mexico', 'unefon', 'iusacell'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'AT&T México publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: ['If the setting is refused, ask AT&T México whether forwarding is enabled for your plan.'],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'mx-movistar',
    name: 'Movistar México',
    kind: 'mobile',
    countries: ['MX'],
    aliases: ['movistar', 'movistar mexico', 'telefonica mexico', 'pegaso'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Movistar México publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'mx-telmex',
    name: 'Telmex',
    kind: 'landline',
    countries: ['MX'],
    aliases: ['telmex', 'telefonos de mexico', 'teléfonos de méxico', 'infinitum'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered within 20 seconds',
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
      'Needs Telmex’s “Sígueme” service on the line; dial from a tone phone on that line.',
      'With Telmex voicemail, set voicemail to answer after more than 20 seconds, or it takes the call first.',
      'Each forwarded call is charged as a local or mobile call from your line.',
      'While forwarding is on, the dial tone sounds different.',
    ],
    sources: [
      {
        url: 'https://telmex.com/web/asistencia/negocios-utiliza-sigueme',
        label: 'Telmex Negocios: utiliza Sígueme',
      },
      {
        url: 'https://telmex.com/web/asistencia/hogar-utiliza-sigueme',
        label: 'Telmex Hogar: utiliza Sígueme',
      },
    ],
  },
  {
    id: 'mx-other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['MX'],
    aliases: ['other', 'mobile', 'cell', 'bait', 'virgin mobile mexico', 'altan'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Mexican carriers other than Telcel publish no forwarding codes; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'br-claro',
    name: 'Claro',
    kind: 'mobile',
    countries: ['BR'],
    aliases: ['claro brasil', 'claro móvel', 'claro movel', 'nextel brasil'],
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
    check: [
      {
        code: '*#21#',
        when: 'Every call',
      },
    ],
    note: 'Claro only documents forwarding every call (Siga-me) on mobile. For missed calls only, use the phone’s call forwarding settings.',
    pitfalls: [
      'Claro writes the number with 0 and the area code (DDD) when it’s in another area; for your own area the number alone also works.',
      'A text message confirms it.',
      'Forwarded calls are charged by length, like a call from your plan.',
    ],
    sources: [
      {
        url: 'https://www.claro.com.br/faq/ligacoes-e-sms/o-que-e-o-siga-me',
        label: 'Claro: o que é o Siga-me',
      },
    ],
  },
  {
    id: 'br-tim',
    name: 'TIM',
    kind: 'mobile',
    countries: ['BR'],
    aliases: ['tim brasil', 'tim celular', 'oi móvel', 'oi movel'],
    how: 'dial',
    numberFormat: 'nsn',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*041{number}#',
            when: 'Not answered',
          },
          {
            code: '*67*041{number}#',
            when: 'Busy',
          },
          {
            code: '*62*041{number}#',
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
            code: '*21*041{number}#',
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
      'Postpaid only: TIM’s Siga-me doesn’t work on prepaid lines.',
      'TIM writes the number as 0 + carrier code (41 for TIM) + area code + number.',
      'Siga-me is free; forwarded calls are charged like a call from your line to that number.',
      'Busy and unreachable forwarding don’t work while roaming abroad.',
    ],
    sources: [
      {
        url: 'https://www.tim.com.br/para-voce/servicos-tim/servicos-basicos/siga-me',
        label: 'TIM: Siga-me',
      },
      {
        url: 'https://www.tim.com.br/ajuda/perguntas-frequentes/tudo-sobre-tim/facilidades/siga-me',
        label: 'TIM: Siga-me FAQ',
      },
    ],
  },
  {
    id: 'br-vivo',
    name: 'Vivo',
    kind: 'mobile',
    countries: ['BR'],
    aliases: ['vivo', 'telefônica brasil', 'telefonica brasil'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Vivo publishes no current forwarding codes for mobile lines; set it in the phone’s call settings.',
    pitfalls: ['If the setting is refused, ask Vivo to turn on call forwarding (Siga-me) for the line.'],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'br-claro-fixo',
    name: 'Claro fixo (NET fone)',
    kind: 'landline',
    countries: ['BR'],
    aliases: ['claro net fone', 'net fone', 'net', 'claro residencial', 'embratel'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*61*{number}#',
            when: 'Not answered within 20 seconds',
          },
          {
            code: '*63*{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#61#',
          },
          {
            code: '#63#',
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
    pitfalls: ['Ask Claro to activate Siga-me on the line first.', 'Claro uses *63* for busy on landlines (not *67*).'],
    sources: [
      {
        url: 'https://www.claro.com.br/faq/ligacoes-e-sms/como-programar-o-servico-siga-me-no-meu-claro-net-fone',
        label: 'Claro: programar o Siga-me no Claro net fone',
      },
    ],
  },
  {
    id: 'br-other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['BR'],
    aliases: ['other', 'mobile', 'cell', 'algar', 'sercomtel'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Set it in the phone’s call settings; the codes and number format differ by Brazilian carrier.',
    pitfalls: ['Most Brazilian carriers only allow forwarding on postpaid lines.'],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'ar-personal',
    name: 'Personal',
    kind: 'mobile',
    countries: ['AR'],
    aliases: ['personal', 'telecom personal', 'telecom argentina', 'personal flow'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Personal publishes no forwarding codes; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'ar-claro',
    name: 'Claro Argentina',
    kind: 'mobile',
    countries: ['AR'],
    aliases: ['claro', 'claro argentina', 'amx argentina', 'cti movil'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Claro Argentina publishes no forwarding codes; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'ar-movistar',
    name: 'Movistar Argentina',
    kind: 'mobile',
    countries: ['AR'],
    aliases: ['movistar', 'movistar argentina', 'telefonica moviles argentina', 'telefe'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Movistar Argentina documents forwarding in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'ar-movistar-fijo',
    name: 'Movistar fixed line',
    kind: 'landline',
    countries: ['AR'],
    aliases: ['movistar fijo', 'telefonica de argentina', 'speedy'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*40*{number}#',
          },
        ],
        off: [
          {
            code: '#40#',
          },
        ],
      },
    },
    note: 'Movistar documents forwarding every call on fixed lines only.',
    pitfalls: [
      'Order “Desvío Directo” from Movistar first.',
      'Enter the number the way you’d dial it from this line: drop the area code when it’s the same as yours.',
      'Lines that block calls to mobiles can’t forward to mobile numbers.',
      'You pay the forwarded leg from your line to the assistant; the caller pays only their call.',
    ],
    sources: [
      {
        url: 'https://ayuda.movistar.com.ar/empresas/pregunta/que-es-desvio-directo-y-como-lo-activo.html',
        label: 'Movistar Argentina: Desvío Directo',
      },
      {
        url: 'https://ayuda.movistar.com.ar/empresas/pregunta/que-es-desvio-de-llamadas.html',
        label: 'Movistar Argentina: desvío de llamadas',
      },
    ],
  },
  {
    id: 'ar-other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['AR'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'cl-entel',
    name: 'Entel',
    kind: 'mobile',
    countries: ['CL'],
    aliases: ['entel', 'entel pcs', 'entel chile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Entel publishes no forwarding codes for mobile lines; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'cl-movistar',
    name: 'Movistar Chile',
    kind: 'mobile',
    countries: ['CL'],
    aliases: ['movistar', 'movistar chile', 'telefonica chile', 'telefónica móviles chile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Movistar Chile documents forwarding in the phone’s call settings.',
    pitfalls: [
      'Movistar’s voicemail number is +56 9 9161 0500: set unanswered forwarding back to it to get voicemail back.',
      '##002# cancels every forwarding at once.',
    ],
    sources: [
      {
        url: 'https://ayuda.movistar.cl/hc/centro-de-ayuda/articles/76178664568311-como-cancelar-todos-los-desvios-de-llamada-en-el-celular',
        label: 'Movistar Chile: cancelar todos los desvíos',
      },
      APPLE_CALL_FORWARDING,
      SAMSUNG_CALL_FORWARDING_ON,
    ],
  },
  {
    id: 'cl-claro',
    name: 'Claro Chile',
    kind: 'mobile',
    countries: ['CL'],
    aliases: ['claro', 'claro chile', 'vtr', 'claro vtr'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Claro Chile’s forwarding page couldn’t be opened; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'cl-wom',
    name: 'WOM Chile',
    kind: 'mobile',
    countries: ['CL'],
    aliases: ['wom', 'wom chile', 'nextel chile'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'WOM publishes no forwarding codes; set it in the phone’s call settings.',
    pitfalls: ['On a dual-SIM phone, set forwarding for the WOM SIM.'],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'cl-entel-one',
    name: 'Entel One (cloud phone system)',
    kind: 'landline',
    countries: ['CL'],
    aliases: ['entel one', 'entel empresas'],
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
            code: '*48*{number}#',
            when: 'No coverage',
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
            code: '#48#',
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
      'Dial the code from the Entel One app or the desk phone, like a call.',
      'Entel One uses *48* (not *62*) for no coverage.',
    ],
    sources: [
      {
        url: 'https://sitios.entel.cl/hubfs/Friendy%20User%20Entel%20one/Manuales/Codigos%20Cortos.pdf',
        label: 'Entel One: códigos cortos',
      },
    ],
  },
  {
    id: 'cl-other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['CL'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'co-claro',
    name: 'Claro Colombia',
    kind: 'mobile',
    countries: ['CO'],
    aliases: ['claro', 'claro colombia', 'comcel'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Claro Colombia only allows forwarding on company (corporate) lines. On a personal line it can’t be turned on: give your assistant its own number instead.',
    pitfalls: ['If the setting is refused, ask Claro to enable forwarding on your corporate line.'],
    sources: [CLARO_COLOMBIA_DESVIO_DE, APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'co-movistar',
    name: 'Movistar Colombia',
    kind: 'mobile',
    countries: ['CO'],
    aliases: ['movistar', 'movistar colombia', 'telefonica colombia', 'coltel'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Movistar Colombia documents forwarding in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'co-tigo',
    name: 'Tigo',
    kind: 'mobile',
    countries: ['CO'],
    aliases: ['tigo colombia', 'tigo une', 'colombia movil'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Tigo publishes no forwarding codes for mobile lines; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'co-wom',
    name: 'WOM Colombia',
    kind: 'mobile',
    countries: ['CO'],
    aliases: ['wom', 'wom colombia', 'partners telecom colombia'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'WOM publishes no forwarding codes; set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
  {
    id: 'co-claro-fijo',
    name: 'Claro Colombia fixed line',
    kind: 'landline',
    countries: ['CO'],
    aliases: ['claro hogar', 'claro fijo', 'telmex colombia'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_all: {
        on: [
          {
            code: '*72{number}',
          },
        ],
        off: [
          {
            code: '*73',
          },
        ],
      },
    },
    note: 'Claro documents forwarding every call only.',
    pitfalls: [
      'Forwarding to a mobile or a long-distance number costs extra.',
      'Claro allows forwarding on company lines only; personal fixed lines are blocked.',
    ],
    sources: [
      {
        url: 'https://www.claro.com.co/personas/servicios/servicios-hogar/telefonia-fija/funcionalidades/',
        label: 'Claro Colombia: funcionalidades del teléfono fijo',
      },
      CLARO_COLOMBIA_DESVIO_DE,
    ],
  },
  {
    id: 'co-tigo-fijo',
    name: 'Tigo fixed line',
    kind: 'landline',
    countries: ['CO'],
    aliases: ['tigo hogar', 'tigo fijo', 'une', 'une epm'],
    how: 'dial',
    numberFormat: 'national',
    modes: {
      forward_conditional: {
        on: [
          {
            code: '*13{number}#',
            when: 'Not answered after 4 rings',
          },
          {
            code: '*14{number}#',
            when: 'Busy',
          },
        ],
        off: [
          {
            code: '#13#',
          },
          {
            code: '#14#',
          },
        ],
      },
      forward_all: {
        on: [
          {
            code: '*06{number}#',
          },
        ],
        off: [
          {
            code: '#06#',
          },
        ],
      },
    },
    pitfalls: [
      'Lift the receiver, wait for the tone, dial the code; a message confirms it.',
      'In Pereira and Ibagué Tigo uses other codes: *22#, the number, # to forward every call, #23# to stop.',
      'If the code is refused, ask Tigo to turn on the special services for the line.',
    ],
    sources: [
      {
        url: 'https://ayuda.tigo.com.co/hc/centro-de-ayuda/articles/1728716868-como-configurar-servicios-especiales-en-su-linea-telefonica-general',
        label: 'Tigo: servicios especiales de la línea fija',
      },
    ],
  },
  {
    id: 'co-other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['CO'],
    aliases: ['other', 'mobile', 'cell', 'etb movil'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Set it in the phone’s call settings.',
    pitfalls: [],
    sources: [APPLE_CALL_FORWARDING, SAMSUNG_CALL_FORWARDING_ON],
  },
]
