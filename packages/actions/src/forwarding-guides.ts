// How a business forwards its own number to the assistant, per carrier, carrier brand and phone system: the codes
// to dial (mobile and landline networks) or the settings to change (phone systems and apps), the codes that turn it
// off again, how to check it, what typically goes wrong, and where it is written down. Shared by onboarding and
// Settings › Phone numbers (apps/web), and by the carrier lookup that preselects a guide by the carrier's name.
//
// Rule for this file: a code is only here when the carrier's own page (or, for the standard GSM codes, the 3GPP
// standard plus a carrier of the same network) says it. What isn't documented is left out, not guessed: the guide
// then offers what it has (often forwarding every call, or the phone's own settings) and says so in `note`.
//
// Countries: every guide names the countries it is for (ISO 3166-1 alpha-2, or 'any' for an app usable everywhere).
// Guides outside the US have ids '<cc>-<slug>' ('de-telekom'), and every country has a '<cc>-other-mobile' fallback
// for any other cell carrier ('other-mobile' for the US, kept for stored picks): the standard GSM codes where a
// carrier of that country documents them, else the phone's own settings. A country with no guides, or "Other
// country" (OTHER_COUNTRY), gets the GSM codes with the number written internationally, and the phone's own settings.
// The US guides are below; the other countries are in ./forwarding-guides/, one file per region, and the phone
// systems (with the countries each sells numbers in) in ./forwarding-guides/phone-systems.ts.
import { getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/max'

import { americasGuides } from './forwarding-guides/americas.ts'
import { apacMeaGuides } from './forwarding-guides/apac-mea.ts'
import { europeNorthWestGuides } from './forwarding-guides/europe-north-west.ts'
import { europeSouthNordicsGuides } from './forwarding-guides/europe-south-nordics.ts'
import { phoneSystemGuides } from './forwarding-guides/phone-systems.ts'
import {
  type DialCode,
  type DialGuide,
  type ForwardingGuide,
  type ForwardingMode,
  GSM_CHECK,
  GSM_STANDARD,
  type GuideKind,
  gsmModes,
  type NumberFormat,
  OTHER_COUNTRY,
  phoneMenuModes,
} from './forwarding-guides/shared.ts'

export type {
  DialCode,
  DialGuide,
  DialSteps,
  ForwardingGuide,
  ForwardingMode,
  GuideBase,
  GuideKind,
  NumberFormat,
  SettingSteps,
  SettingsGuide,
} from './forwarding-guides/shared.ts'
export { OTHER_COUNTRY }

export const guideKindLabels: Record<GuideKind, string> = {
  mobile: 'Cell phone',
  landline: 'Landline or cable phone',
  phone_system: 'Phone system or app',
}

// Sources used by several guides.
const TMOBILE_CODES = {
  url: 'https://www.t-mobile.com/support/plans-features/self-service-short-codes',
  label: 'T-Mobile self-service short codes',
}
const ATT_IPHONE = {
  url: 'https://www.att.com/device-support/article/142305/apple/iphone-17-pro',
  label: 'AT&T: call forwarding on iPhone',
}
const ATT_ANDROID = {
  url: 'https://www.att.com/device-support/article/140337/google/pixel-10-pro/',
  label: 'AT&T: call forwarding on Android (Pixel)',
}

/** Verizon's network: one code for busy or unanswered calls, one for every call, `*73` turns both off. */
const verizonModes: DialGuide['modes'] = {
  forward_conditional: { on: [{ code: '*71{number}', when: 'Calls you miss' }], off: [{ code: '*73' }] },
  forward_all: { on: [{ code: '*72{number}' }], off: [{ code: '*73' }] },
}
const VERIZON_PITFALLS = [
  'Dial it from the phone itself; it can’t be set up online.',
  '*73 turns off both kinds of forwarding.',
  'The network decides how long it rings before forwarding (a few rings); it can’t be changed.',
  'The confirmation tone can sound like a busy signal. That’s normal: hang up after it.',
] as const

/** Every guide, mobile first, then landlines, then phone systems. The first one is the default choice. */
export const forwardingGuides: readonly ForwardingGuide[] = [
  // ---- Mobile: Verizon and brands on its network ----
  {
    id: 'verizon',
    name: 'Verizon',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['verizon wireless', 'cellco', 'vzw'],
    how: 'dial',
    numberFormat: 'ten',
    modes: verizonModes,
    pitfalls: VERIZON_PITFALLS,
    sources: [
      { url: 'https://www.verizon.com/support/call-forwarding-faqs/', label: 'Verizon call forwarding FAQs' },
      {
        url: 'https://www.verizon.com/articles/verizon-unlimited-plans/call-forwarding-everything-you-need-to-know/',
        label: 'Verizon: call forwarding, everything you need to know',
      },
    ],
  },
  {
    id: 'visible',
    name: 'Visible',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['visible wireless'],
    network: 'Verizon',
    how: 'dial',
    numberFormat: 'ten',
    modes: verizonModes,
    pitfalls: [
      'Visible and Verizon describe *71 a little differently (busy calls, unanswered calls). Check it: let a call ring out and see that it reaches your assistant.',
      ...VERIZON_PITFALLS.slice(1),
    ],
    sources: [{ url: 'https://www.visible.com/m/help/about-visible/plan-features', label: 'Visible plan features' }],
  },
  {
    id: 'spectrum-mobile',
    name: 'Spectrum Mobile',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['charter mobile', 'spectrum wireless'],
    network: 'Verizon',
    how: 'dial',
    numberFormat: 'ten',
    modes: verizonModes,
    pitfalls: [
      'Only the account holder can change forwarding. It can also be set online: Spectrum account › Your Services › Mobile › your line › Call Forwarding.',
      'While forwarding is on, unanswered calls no longer go to Spectrum voicemail.',
      '*73 turns off both kinds of forwarding.',
    ],
    sources: [
      {
        url: 'https://www.spectrum.net/support/mobile/spectrum-mobile-call-forwarding',
        label: 'Spectrum Mobile call forwarding',
      },
    ],
  },
  {
    id: 'xfinity-mobile',
    name: 'Xfinity Mobile',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['comcast mobile'],
    network: 'Verizon',
    how: 'dial',
    numberFormat: 'ten',
    modes: verizonModes,
    pitfalls: [
      'Dial it from the Xfinity Mobile phone itself.',
      'While forwarding is on, unanswered calls no longer go to your voicemail.',
      '*73 turns off both kinds of forwarding.',
    ],
    sources: [
      { url: 'https://www.xfinity.com/support/articles/how-to-use-call-forwarding', label: 'Xfinity: call forwarding' },
    ],
  },
  {
    id: 'total-wireless',
    name: 'Total Wireless',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['total by verizon', 'total'],
    network: 'Verizon',
    how: 'dial',
    numberFormat: 'ten',
    modes: { forward_all: verizonModes.forward_all! },
    note: 'Total Wireless only documents forwarding every call, and only on some phones and in some areas.',
    pitfalls: ['If the code is refused, this line can’t forward: get a new number for your assistant instead.'],
    sources: [
      {
        url: 'https://support.totalwireless.com/en/brands/Samsung/TWSAS767VL/faq/1647737/',
        label: 'Total Wireless: call forwarding',
      },
    ],
  },
  {
    id: 'straight-talk',
    name: 'Straight Talk',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['tracfone', 'straighttalk'],
    network: 'Verizon',
    how: 'dial',
    numberFormat: 'ten',
    modes: { forward_all: verizonModes.forward_all! },
    note: 'Straight Talk only documents forwarding every call, and only on some phones and in some areas.',
    pitfalls: ['If the code is refused, this line can’t forward: get a new number for your assistant instead.'],
    sources: [
      {
        url: 'https://support.straighttalk.com/en/brands/General/STaccounthelp/faq/1647737/',
        label: 'Straight Talk: call forwarding',
      },
    ],
  },
  // ---- Mobile: AT&T and brands on its network ----
  {
    id: 'att',
    name: 'AT&T',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['at&t wireless', 'at&t mobility', 'att mobility', 'at and t', 'cingular', 'new cingular wireless'],
    how: 'dial',
    numberFormat: 'ten',
    ringSeconds: 20,
    modes: gsmModes(20, { on: [{ code: '*21*{number}#' }], off: [{ code: '#21#' }] }),
    check: GSM_CHECK,
    pitfalls: [
      'Dial the codes from the phone itself, one after the other, and wait for the confirmation on screen.',
      'Forwarded calls skip AT&T voicemail.',
      'AT&T documents the every-call code; the missed-call codes are the standard GSM ones its network uses. The check shows whether they took.',
    ],
    sources: [
      { url: 'https://www.att.com/support/article/wireless/KM1011513/', label: 'AT&T: call forwarding' },
      {
        url: 'https://www.att.com/device-support/article/147973/undefined/undefined/',
        label: 'AT&T: call forwarding codes',
      },
      GSM_STANDARD,
      ATT_ANDROID,
    ],
  },
  {
    id: 'cricket',
    name: 'Cricket Wireless',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['cricket'],
    network: 'AT&T',
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Cricket publishes no forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: ['No international numbers.'],
    sources: [
      { url: 'https://www.cricketwireless.com/support/plans-and-features/features', label: 'Cricket plan features' },
      ATT_IPHONE,
      ATT_ANDROID,
    ],
  },
  // ---- Mobile: T-Mobile and brands on its network ----
  {
    id: 'tmobile',
    name: 'T-Mobile',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['t-mobile usa', 't mobile', 'tmobile', 'sprint', 'omnipoint', 'powertel'],
    how: 'dial',
    numberFormat: 'eleven',
    ringSeconds: 20,
    modes: gsmModes(20, { on: [{ code: '**21*{number}#' }], off: [{ code: '##21#' }] }),
    check: GSM_CHECK,
    pitfalls: [
      'Dial the codes from the phone itself, one after the other.',
      'Missed calls forward instead of going to T-Mobile voicemail. ##004# turns all forwarding off and sends them back to voicemail.',
      'The ring time can be 5 to 30 seconds; 20 leaves you time to pick up.',
    ],
    sources: [TMOBILE_CODES],
  },
  {
    id: 'metro',
    name: 'Metro by T-Mobile',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['metropcs', 'metro pcs', 'metro'],
    network: 'T-Mobile',
    how: 'dial',
    numberFormat: 'eleven',
    ringSeconds: 20,
    modes: gsmModes(20, { on: [{ code: '**21*{number}#' }], off: [{ code: '##21#' }] }),
    check: GSM_CHECK,
    note: 'Metro runs on T-Mobile’s network and uses T-Mobile’s codes.',
    pitfalls: ['Dial the codes from the phone itself.', '##004# turns all forwarding off.'],
    sources: [TMOBILE_CODES],
  },
  {
    id: 'mint',
    name: 'Mint Mobile',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['mint'],
    network: 'T-Mobile',
    how: 'dial',
    numberFormat: 'eleven',
    modes: gsmModes(null, { on: [{ code: '**21*{number}#' }], off: [{ code: '##21#' }] }),
    check: GSM_CHECK,
    pitfalls: ['Dial the codes from the phone itself.'],
    sources: [
      {
        url: 'https://www.mintmobile.com/help/how-to-turn-on-off-call-forwarding/',
        label: 'Mint Mobile: call forwarding',
      },
      {
        url: 'https://www.mintmobile.com/faqs/how-do-i-turn-on-off-call-forwarding/',
        label: 'Mint Mobile FAQ: call forwarding',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'us-mobile-warp',
    name: 'US Mobile (Warp)',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['us mobile', 'usmobile'],
    network: 'Verizon',
    how: 'dial',
    numberFormat: 'ten',
    modes: verizonModes,
    note: 'Your US Mobile network (Warp, Light Speed or Dark Star) is shown in the US Mobile app.',
    pitfalls: [
      'US Mobile and Verizon describe *71 a little differently (busy calls, unanswered calls). Check it: let a call ring out and see that it reaches your assistant.',
    ],
    sources: [
      {
        url: 'https://www.usmobile.com/help/docs/troubleshooting-and-setup/setting-up-device/advanced-device-setup',
        label: 'US Mobile: advanced device setup',
      },
    ],
  },
  {
    id: 'us-mobile-light-speed',
    name: 'US Mobile (Light Speed)',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['us mobile', 'usmobile'],
    network: 'AT&T',
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: { on: [{ code: '**61*{number}#', when: 'Not answered' }], off: [{ code: '##61#' }] },
      forward_all: { on: [{ code: '**21*{number}#' }], off: [{ code: '##21#' }] },
    },
    check: GSM_CHECK,
    note: 'Your US Mobile network (Warp, Light Speed or Dark Star) is shown in the US Mobile app.',
    pitfalls: ['Only unanswered calls forward with this code; busy calls still go to voicemail.'],
    sources: [
      {
        url: 'https://www.usmobile.com/help/docs/troubleshooting-and-setup/setting-up-device/advanced-device-setup',
        label: 'US Mobile: advanced device setup',
      },
    ],
  },
  {
    id: 'us-mobile-dark-star',
    name: 'US Mobile (Dark Star)',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['us mobile', 'usmobile'],
    network: 'T-Mobile',
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [
          { code: '*61*{number}#', when: 'Not answered' },
          { code: '*67*{number}#', when: 'Busy' },
          { code: '*62*{number}#', when: 'Phone off or no signal' },
        ],
        off: [{ code: '#61#' }, { code: '#67#' }, { code: '#62#' }],
      },
      forward_all: { on: [{ code: '*21*{number}#' }], off: [{ code: '#21#' }] },
    },
    check: GSM_CHECK,
    note: 'Your US Mobile network (Warp, Light Speed or Dark Star) is shown in the US Mobile app.',
    pitfalls: ['On iPhone, Dark Star forwarding needs iOS 18.5 or later.'],
    sources: [
      {
        url: 'https://www.usmobile.com/help/docs/troubleshooting-and-setup/setting-up-device/advanced-device-setup',
        label: 'US Mobile: advanced device setup',
      },
      GSM_STANDARD,
    ],
  },
  {
    id: 'us-cellular',
    name: 'UScellular',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['us cellular', 'u.s. cellular', 'united states cellular'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'UScellular publishes no forwarding codes (its lines are moving to T-Mobile); it’s set in the phone’s call settings.',
    pitfalls: ['If the setting is greyed out, ask UScellular to turn call forwarding on for the line.'],
    sources: [{ url: 'https://www.uscellular.com/support', label: 'UScellular support' }, ATT_IPHONE, ATT_ANDROID],
  },
  {
    id: 'google-fi',
    name: 'Google Fi',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['fi', 'project fi', 'google fi wireless'],
    how: 'settings',
    where: 'the Google Fi app or fi.google.com',
    modes: {
      forward_all: {
        on: [
          'Open the Google Fi app or fi.google.com.',
          'Home › Phone settings › Call forwarding.',
          'Choose “Always forward”, add {number} and verify it with the code Google sends.',
        ],
        off: ['Choose “Don’t forward” in the same place.'],
      },
    },
    check: 'Google Fi app › Phone settings › Call forwarding',
    note: 'Google Fi can’t forward only the calls you miss. Forward every call, or give your assistant its own new number.',
    pitfalls: ['Codes and the phone’s own forwarding settings don’t work on Fi; only the Fi app does.'],
    sources: [{ url: 'https://support.google.com/fi/answer/6201380?hl=en', label: 'Google Fi: call forwarding' }],
  },
  {
    id: 'boost',
    name: 'Boost Mobile',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['boost', 'dish wireless'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Boost has no current page with forwarding codes; it’s set in the phone’s call settings.',
    pitfalls: ['Some Boost plans can’t forward missed calls only. If so, forward every call.'],
    sources: [ATT_IPHONE, ATT_ANDROID],
  },
  {
    id: 'consumer-cellular',
    name: 'Consumer Cellular',
    kind: 'mobile',
    countries: ['US'],
    aliases: [],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Consumer Cellular documents forwarding in the phone’s call settings.',
    pitfalls: [],
    sources: [ATT_IPHONE, ATT_ANDROID],
  },
  {
    id: 'other-mobile',
    name: 'Another cell carrier',
    kind: 'mobile',
    countries: ['US'],
    aliases: ['other', 'mobile', 'cell'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Most carriers also have codes: search for your carrier and “conditional call forwarding”.',
    pitfalls: [],
    sources: [ATT_IPHONE, ATT_ANDROID],
  },
  // ---- Mobile: "Other country" (and any country without its own guides yet) ----
  {
    id: 'zz-other-mobile',
    name: 'Cell phone: standard codes',
    kind: 'mobile',
    countries: [OTHER_COUNTRY],
    aliases: ['other', 'mobile', 'cell', 'gsm'],
    how: 'dial',
    numberFormat: 'international',
    modes: gsmModes(null, { on: [{ code: '**21*{number}#' }], off: [{ code: '##21#' }] }),
    check: GSM_CHECK,
    note: 'These are the standard GSM codes most cell networks use; your carrier’s codes can differ. If a code is refused, use your phone’s settings instead.',
    pitfalls: [
      'Dial the codes from the phone itself, one after the other, and wait for the confirmation on screen.',
      'Forwarding to a number in another country can cost extra, or your carrier may block it.',
    ],
    sources: [GSM_STANDARD],
  },
  {
    id: 'zz-phone-settings',
    name: 'Cell phone: phone settings',
    kind: 'mobile',
    countries: [OTHER_COUNTRY],
    aliases: ['other', 'mobile', 'cell', 'settings'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'The menu names can differ by phone and carrier.',
    pitfalls: ['Forwarding to a number in another country can cost extra, or your carrier may block it.'],
    sources: [ATT_IPHONE, ATT_ANDROID],
  },
  // ---- Landline and cable business lines: dialled from the desk phone ----
  {
    id: 'comcast-business',
    name: 'Comcast Business Voice',
    kind: 'landline',
    countries: ['US'],
    aliases: ['comcast business', 'voiceedge'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [
          { code: '*92 {number}', when: 'Not answered' },
          { code: '*90 {number}', when: 'Busy' },
        ],
        off: [{ code: '*93' }, { code: '*91' }],
      },
      forward_all: { on: [{ code: '*72 {number}' }], off: [{ code: '*73' }] },
    },
    pitfalls: [
      'Dial the star code, wait for the prompt, then the number.',
      'The number of rings is set in Comcast Business My Account › Phone › Features › Call Forwarding; 4 rings is about 20 seconds.',
      'The Comcast Business app can do it too: My Phone › Call Forwarding.',
    ],
    sources: [
      {
        url: 'https://secure.xfinity.com/anon.comcastonline2/support/helpandsupport/businessclass/help_articles/CB_BVE_StarCodes_SLS90624_3.18.pdf',
        label: 'Comcast Business VoiceEdge star codes',
      },
      {
        url: 'https://business.comcast.com/support/article/voice/call-forwarding-comcast-business-app',
        label: 'Comcast Business app: call forwarding',
      },
    ],
  },
  {
    id: 'att-business-line',
    name: 'AT&T business landline',
    kind: 'landline',
    countries: ['US'],
    aliases: [
      'at&t phone',
      'at&t local',
      'att landline',
      'at&t landline',
      'u-verse voice',
      'bellsouth',
      'pacific bell',
    ],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [
          { code: '*92{number}#', when: 'Not answered' },
          { code: '*90{number}#', when: 'Busy' },
        ],
        off: [{ code: '*93#' }, { code: '*91#' }],
      },
      forward_all: { on: [{ code: '*72{number}#' }], off: [{ code: '*73#' }] },
    },
    pitfalls: [
      'Dial from the business line itself.',
      'Some lines call the new number once to confirm: your assistant answers that call, so the code takes.',
      'If your voicemail stops working, it was the no-answer forwarding: that’s expected.',
    ],
    sources: [
      {
        url: 'https://www.att.com/support/smallbusiness/article/smb-local-long-distance/KM1181691/',
        label: 'AT&T small business: call forwarding',
      },
      { url: 'https://www.att.com/support/article/u-verse-voice/KM1000459/', label: 'AT&T Phone: call forwarding' },
    ],
  },
  {
    id: 'verizon-landline',
    name: 'Verizon Fios or business landline',
    kind: 'landline',
    countries: ['US'],
    aliases: ['verizon fios', 'fios', 'verizon business', 'verizon landline', 'fios digital voice'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [{ code: '*92 {number}', when: 'Busy or not answered' }],
        off: [{ code: '*93' }],
      },
      forward_all: { on: [{ code: '*72 {number}' }], off: [{ code: '*73' }] },
    },
    pitfalls: [
      'Dial the star code, wait for the tone, then the number.',
      'Verizon calls the new number once to confirm: your assistant answers that call, so the code takes.',
      'In some areas busy and no-answer forwarding is set up by Verizon. If *92 is refused, use My Verizon › Calling Features, or forward every call.',
    ],
    sources: [
      {
        url: 'https://www.verizon.com/support/residential/homephone/calling-features/star-codes-other-features',
        label: 'Verizon star codes',
      },
      {
        url: 'https://www.verizon.com/business/support/equipment-devices-services/traditional-phones/calling-features/',
        label: 'Verizon Business calling features',
      },
    ],
  },
  {
    id: 'cox-business',
    name: 'Cox Business Voice',
    kind: 'landline',
    countries: ['US'],
    aliases: ['cox business'],
    how: 'dial',
    numberFormat: 'ten',
    modes: {
      forward_conditional: {
        on: [
          { code: '*92 {number}', when: 'Not answered' },
          { code: '*90 {number}', when: 'Busy' },
        ],
        off: [{ code: '*93' }, { code: '*91' }],
      },
      forward_all: { on: [{ code: '*72 {number}' }], off: [{ code: '*73' }] },
    },
    pitfalls: [
      'Dial the star code, wait for the dial tone, then the number. A stutter tone means it’s on.',
      'Some Cox feature packages don’t include every code; Cox turns them on on request.',
    ],
    sources: [
      {
        url: 'https://www.cox.com/business/support/using-call-forwarding.html',
        label: 'Cox Business: call forwarding',
      },
    ],
  },
  {
    id: 'spectrum-business',
    name: 'Spectrum Business Voice',
    kind: 'landline',
    countries: ['US'],
    aliases: ['spectrum business', 'charter business'],
    how: 'settings',
    where: 'SpectrumBusiness.net',
    modes: {
      forward_conditional: {
        on: [
          'Sign in to SpectrumBusiness.net as the administrator.',
          'Services › Business Phone › Settings › Manage Settings.',
          'Call Forwarding › “Missed Calls” › “Forward to Phone Number” › {number} › Save.',
          'Do the same for “Busy Line”.',
        ],
        off: ['Set “Missed Calls” and “Busy Line” back to voicemail in the same place.'],
      },
      forward_all: {
        on: [
          'Sign in to SpectrumBusiness.net as the administrator.',
          'Services › Business Phone › Settings › Manage Settings › Call Forwarding.',
          'Forward all calls › “Forward to Phone Number” › {number} › Save. From the desk phone: *72, wait for the dial tone, {number}#.',
        ],
        off: ['Turn it off in the same place, or dial *73 from the desk phone.'],
      },
    },
    check: 'SpectrumBusiness.net › Business Phone › Settings › Call Forwarding',
    pitfalls: [
      'Missed calls go to voicemail until you change “Missed Calls”.',
      'Spectrum sets the number of rings before a missed call forwards.',
    ],
    sources: [
      {
        url: 'https://www.spectrumbusiness.net/support/voice/call-forwarding-features-and-access-codes',
        label: 'Spectrum Business: call forwarding',
      },
    ],
  },
  // ---- Other countries (one file per region) and phone systems ----
  ...americasGuides,
  ...europeNorthWestGuides,
  ...europeSouthNordicsGuides,
  ...apacMeaGuides,
  ...phoneSystemGuides,
]

/**
 * What to turn off on a cell phone before testing, because the phone can answer before the network forwards.
 * The same for every mobile carrier.
 */
export const phoneChecklist: readonly string[] = [
  'iPhone: Settings › Apps › Phone › Live Voicemail off, and Screen Unknown Callers set to Never.',
  'Pixel: Phone app › Settings › Call Assist › Call Screen off.',
  'Samsung: Phone app › Settings › Bixby text call (auto screen calls) off.',
]

export const forwardingGuideById = (id: string | null | undefined): ForwardingGuide | undefined =>
  forwardingGuides.find(g => g.id === id)
/** The guide with this id, of any country. */
export const findGuide = forwardingGuideById

// ---- Countries ----

/** Whether a guide is for `country` (an app or phone system with 'any' is for every country). */
export const guideInCountry = (guide: ForwardingGuide, country: string): boolean =>
  guide.countries === 'any' || guide.countries.includes(country.toUpperCase())

/** The one country a guide is for, or null for a guide of several countries or 'any'. */
export const guideCountry = (guide: ForwardingGuide): string | null =>
  guide.countries !== 'any' && guide.countries.length === 1 ? guide.countries[0]! : null

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' })
  } catch {
    return null
  }
})()
/** A country's name in English ("DE": "Germany"); the code itself when the runtime has no names. */
export const countryName = (code: string): string =>
  code === OTHER_COUNTRY ? 'Other country' : (regionNames?.of(code) ?? code)

/**
 * The countries with carrier guides of their own (cell phones and landlines; a phone system selling numbers in a
 * country doesn't make it one), by name. "Other country" is not in it.
 */
export const forwardingCountries: readonly { code: string; name: string }[] = [
  ...new Set(forwardingGuides.flatMap(g => (g.countries === 'any' || g.kind === 'phone_system' ? [] : g.countries))),
]
  .filter(code => code !== OTHER_COUNTRY)
  .map(code => ({ code, name: countryName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** The "Other country" choice, listed after forwardingCountries. */
export const otherCountryOption = { code: OTHER_COUNTRY, name: countryName(OTHER_COUNTRY) } as const

/** Whether `code` is a country with guides of its own. */
export const hasForwardingCountry = (code: string | null | undefined): boolean =>
  !!code && forwardingCountries.some(c => c.code === code.toUpperCase())

const KIND_ORDER: readonly GuideKind[] = ['mobile', 'landline', 'phone_system']

/**
 * A phone system sold in at least this many countries counts as international: it is listed in every country of the
 * picker, "Other country" included, whatever its own country list says (a business abroad often signs up with one
 * anyway, and listing more beats missing the one the owner has). Below it a system is regional (Grasshopper, Nextiva,
 * sipgate …) and shown only in its own countries. Systems for 'any' country (3CX) are international too.
 */
export const INTERNATIONAL_SYSTEM_MIN_COUNTRIES = 10

/** Whether a phone system is listed in every country (INTERNATIONAL_SYSTEM_MIN_COUNTRIES). */
export const isInternationalSystem = (g: ForwardingGuide): boolean =>
  g.kind === 'phone_system' && (g.countries === 'any' || g.countries.length >= INTERNATIONAL_SYSTEM_MIN_COUNTRIES)

/** The EU and EEA countries, Switzerland and the United Kingdom: where AVM sells the FRITZ!Box. */
const EUROPE = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH GB'.split(' ')

/**
 * Guides also listed in countries beyond their own (whose carrier guides they don't make): the FRITZ!Box router is
 * sold across Europe, its guide is the same everywhere.
 */
const ALSO_LISTED_IN: Readonly<Record<string, readonly string[]>> = { fritzbox: EUROPE }

/**
 * The guides for a country: its carriers (cell phones first, then landlines), then the phone systems: the regional ones
 * sold there first, then every international one A–Z (isInternationalSystem). A country without carrier guides of its
 * own (or OTHER_COUNTRY) gets the "Other country" guides (the standard GSM codes and the phone's own settings).
 */
export function guidesForCountry(code: string): ForwardingGuide[] {
  const asked = code.toUpperCase()
  const carriers = hasForwardingCountry(asked) ? asked : OTHER_COUNTRY
  const carrierGuides = forwardingGuides
    .map((g, i) => ({ g, i }))
    .filter(
      ({ g }) => g.kind !== 'phone_system' && (guideInCountry(g, carriers) || !!ALSO_LISTED_IN[g.id]?.includes(asked)),
    )
    .sort((a, b) => KIND_ORDER.indexOf(a.g.kind) - KIND_ORDER.indexOf(b.g.kind) || a.i - b.i)
    .map(({ g }) => g)
  const systems = forwardingGuides.filter(g => g.kind === 'phone_system')
  const regional = systems.filter(g => !isInternationalSystem(g) && guideInCountry(g, asked))
  const international = systems.filter(isInternationalSystem).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return [...carrierGuides, ...regional, ...international]
}

/** The country of a number in E.164 ("+4930…": "DE"), or null when it can't be told. */
export function phoneCountry(e164: string | null | undefined): string | null {
  if (!e164) return null
  const parsed = parsePhoneNumberFromString(e164)
  // A North American number libphonenumber can't place (a 555 test number) is taken as a US one.
  return parsed?.country ?? (parsed?.countryCallingCode === '1' || /^\+1\d{10}$/.test(e164) ? 'US' : null)
}

/** The region of a locale ("de-DE": "DE", "en": null). */
function localeCountry(locale: string | null | undefined): string | null {
  if (!locale) return null
  try {
    return new Intl.Locale(locale).maximize().region ?? null
  } catch {
    return null
  }
}

/**
 * The country the forwarding guide opens with, most likely first: the country set in Workspace settings › General,
 * else the assistant number's country, else the workspace's country (its holiday calendar, else the business's own
 * number), else the browser's locale, else the US. A number or workspace in a country without guides of its own opens
 * "Other country"; a locale only picks a country that has guides.
 */
export function preselectForwardingCountry(from: {
  /** workspace_settings.country: the country the owner set (not the one worked out). */
  country?: string | null
  assistantNumber?: string | null
  workspaceCountry?: string | null
  businessNumber?: string | null
  locale?: string | null
}): string {
  for (const strong of [from.country, phoneCountry(from.assistantNumber), from.workspaceCountry, phoneCountry(from.businessNumber)]) {
    if (strong) return hasForwardingCountry(strong) ? strong.toUpperCase() : OTHER_COUNTRY
  }
  const locale = localeCountry(from.locale)
  return locale && hasForwardingCountry(locale) ? locale : 'US'
}

/**
 * Whether forwarding to the assistant's number goes abroad from `country`: the number belongs to another country
 * (by its calling code, so a Canadian number from the US is not abroad). False for "Other country" and unknown numbers.
 */
export function forwardsAbroad(e164: string, country: string): boolean {
  if (!country || country === OTHER_COUNTRY) return false
  const parsed = parsePhoneNumberFromString(e164)
  if (!parsed) return false
  return parsed.countryCallingCode !== callingCode(country)
}

/**
 * What to tell the owner when the assistant's number is in another country than the business line, or null:
 * `blocked` when the guide's carrier forwards only within its own country (domesticOnly: it won't work), else
 * `abroad` (it can cost extra or be blocked).
 */
export function abroadWarning(
  e164: string,
  country: string,
  guide?: ForwardingGuide | null,
): { kind: 'blocked' | 'abroad'; text: string } | null {
  if (!country || country === OTHER_COUNTRY) return null
  const where = countryName(country)
  // A carrier that forwards only within its country refuses a number of another country even on the same calling
  // code (a US number from a Canadian line).
  const own = phoneCountry(e164)
  if (guide?.domesticOnly && own && own !== country.toUpperCase())
    return {
      kind: 'blocked',
      text: `${guide.name} forwards only to numbers in ${where}, so forwarding to your assistant’s number won’t work. Give your assistant a number in ${where}.`,
    }
  if (!forwardsAbroad(e164, country)) return null
  return {
    kind: 'abroad',
    text: `Your assistant’s number is in another country, so forwarding goes abroad: it can cost extra or be blocked. A number in ${where} avoids that.`,
  }
}

function callingCode(country: string): string | null {
  try {
    return getCountryCallingCode(country.toUpperCase() as Parameters<typeof getCountryCallingCode>[0])
  } catch {
    return null
  }
}

// ---- Matching a carrier name and searching ----

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()

/**
 * The catch-all guides ("Another cell carrier", '<cc>-other-mobile', the "Other country" ones): a carrier lookup
 * never picks one, and the picker search lists one only after every real carrier that matches.
 */
export const isFallbackGuide = (g: ForwardingGuide) =>
  g.id === 'other-mobile' || /-other-mobile$/.test(g.id) || g.id.startsWith('zz-')

/**
 * The guide for a carrier name as a lookup or the owner writes it ("Verizon Wireless", "T-Mobile USA, Inc.",
 * "OpenPhone"), or undefined. Matches the name or an alias as whole words, the longest match first, so
 * "Spectrum Mobile" finds Spectrum Mobile and not Spectrum Business. With `country`, a guide of that country wins;
 * only when none matches there is every country tried.
 */
export function forwardingGuideForCarrier(
  name: string | null | undefined,
  country?: string | null,
): ForwardingGuide | undefined {
  const text = ` ${normalize(name ?? '')} `
  if (!text.trim()) return undefined
  const match = (guides: readonly ForwardingGuide[]) => {
    let best: { guide: ForwardingGuide; length: number } | undefined
    for (const guide of guides) {
      if (isFallbackGuide(guide)) continue
      for (const candidate of [guide.name, ...guide.aliases]) {
        const words = normalize(candidate)
        if (words && text.includes(` ${words} `) && words.length > (best?.length ?? 0))
          best = { guide, length: words.length }
      }
    }
    return best?.guide
  }
  return (country ? match(guidesForCountry(country)) : undefined) ?? match(forwardingGuides)
}

/**
 * Guides of `country` (default the US) matching what was typed in the picker, best first: the name starting with
 * it, then a word of the name, then a former name or alias, then the network or kind ("verizon network",
 * "landline"). Matches start at a word, so "t-mob" finds T-Mobile and its brands, not "AT&T Mobility". A fallback
 * ("Another cell carrier", '<cc>-other-mobile') comes after every real carrier that matches, so its aliases ("other",
 * "mobile", "cell", or a small brand on it) never put it first. All the country's guides (guidesForCountry) for an
 * empty search.
 */
export function searchForwardingGuides(typed: string, country = 'US'): ForwardingGuide[] {
  const guides = guidesForCountry(country)
  const query = normalize(typed)
  if (!query) return guides
  const startsWord = (text: string) => ` ${normalize(text)}`.includes(` ${query}`)
  const rank = (g: ForwardingGuide) => {
    if (normalize(g.name).startsWith(query)) return 0
    if (startsWord(g.name)) return 1
    if (g.aliases.some(startsWord)) return 2
    if (startsWord(g.network ?? '') || startsWord(guideKindLabels[g.kind])) return 3
    return null
  }
  const ranked = (g: ForwardingGuide) => {
    const r = rank(g)
    return r === null ? null : isFallbackGuide(g) ? r + 10 : r
  }
  return guides
    .map((g, i) => ({ g, i, r: ranked(g) }))
    .filter((m): m is { g: ForwardingGuide; i: number; r: number } => m.r !== null)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(m => m.g)
}

// ---- Writing the number ----

/**
 * The assistant's number (E.164) as a dialling guide's codes expect it, dialled from `country`:
 * - `ten` / `eleven`: the 10 digits of a North American number, with the 1 in front for `eleven`;
 * - `national`: the national format, digits only with the trunk prefix (+493012345678: 03012345678);
 * - `nsn`: the national significant number, digits only, no trunk prefix (+5511987654321: 11987654321);
 * - `international`: + and the country code (+493012345678).
 * A number of another calling code than `country`'s (or, without `country`, a non-North American number for `ten`
 * and `eleven`) is written internationally, since only that reaches it from abroad. A number libphonenumber can't
 * read keeps its digits.
 */
export function formatGuideNumber(e164: string, format: NumberFormat, country?: string | null): string {
  const digits = e164.replace(/\D/g, '')
  const international = `+${digits}`
  if (format === 'international') return international
  const parsed = parsePhoneNumberFromString(e164)
  const code = parsed?.countryCallingCode ?? (e164.startsWith('+1') ? '1' : null)
  const home = country && country !== OTHER_COUNTRY ? callingCode(country) : null
  if (home && code !== home) return international
  if (format === 'ten' || format === 'eleven') {
    if (code !== '1') return international
    const ten = digits.slice(1)
    return format === 'eleven' ? `1${ten}` : ten
  }
  if (!parsed) return international
  if (format === 'nsn') return String(parsed.nationalNumber)
  return parsed.formatNational().replace(/\D/g, '')
}

/** The assistant's number as the guide's codes expect it; `country` is the one selected (default: the guide's own). */
export function guideNumber(guide: DialGuide, e164: string, country?: string | null): string {
  return formatGuideNumber(e164, guide.numberFormat, country ?? guideCountry(guide))
}

/** A `tel:` link that opens the phone's dialer with the code filled in (`#` must be written as %23). */
export const dialHref = (code: string) => `tel:${encodeURIComponent(code.replace(/\s+/g, ''))}`

export type ResolvedCode = { code: string; when?: string; href: string }
export type ForwardingInstructions =
  | { how: 'dial'; on: ResolvedCode[]; off: ResolvedCode[]; check: ResolvedCode[] }
  | { how: 'settings'; where: string; on: string[]; off: string[]; check: string | null }

/**
 * What to dial or change to forward to `e164` in `mode`, and how to undo and check it; null when the guide has no
 * way for that mode (its `note` says what to do instead). `country`: the country the business line is in (the one
 * picked), which decides how the number is written; default the guide's own.
 */
export function forwardingInstructions(
  guide: ForwardingGuide,
  mode: ForwardingMode,
  e164: string,
  country?: string | null,
): ForwardingInstructions | null {
  if (guide.how === 'dial') {
    const steps = guide.modes[mode]
    if (!steps) return null
    const number = guideNumber(guide, e164, country)
    const resolve = (c: DialCode): ResolvedCode => {
      const code = c.code.replaceAll('{number}', number)
      return { code, href: dialHref(code), ...(c.when ? { when: c.when } : {}) }
    }
    return {
      how: 'dial',
      on: steps.on.map(resolve),
      off: steps.off.map(resolve),
      check: (guide.check ?? []).map(resolve),
    }
  }
  const steps = guide.modes[mode]
  if (!steps) return null
  const written = writtenNumber(e164)
  const digits = e164.replace(/\D/g, '')
  const fill = (s: string) => s.replaceAll('{number}', written).replaceAll('{digits}', digits)
  return {
    how: 'settings',
    where: guide.where,
    on: steps.on.map(fill),
    off: steps.off.map(fill),
    check: guide.check ?? null,
  }
}

/**
 * +15035550142 → (503) 555-0142, the way US settings pages take it; any other number internationally
 * (+49 30 12345678), which a settings page takes from every country.
 */
function writtenNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164
}

/** The modes a guide has instructions for. */
export const guideModes = (guide: ForwardingGuide): ForwardingMode[] =>
  (['forward_conditional', 'forward_all'] as const).filter(m => !!guide.modes[m])
