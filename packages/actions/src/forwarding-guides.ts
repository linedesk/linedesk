// How a business forwards its own number to the assistant, per carrier, carrier brand and phone system: the codes
// to dial (mobile and landline networks) or the settings to change (phone systems and apps), the codes that turn it
// off again, how to check it, what typically goes wrong, and where it is written down. Shared by onboarding and
// Settings › Phone numbers (apps/web), and by the carrier lookup that preselects a guide by the carrier's name.
//
// Rule for this file: a code is only here when the carrier's own page (or, for the standard GSM codes, the 3GPP
// standard plus a carrier of the same network) says it. What isn't documented is left out, not guessed: the guide
// then offers what it has (often forwarding every call, or the phone's own settings) and says so in `note`.

/** How the business's own number reaches the assistant: only the calls it misses, or every call. */
export type ForwardingMode = 'forward_conditional' | 'forward_all'
export type GuideKind = 'mobile' | 'landline' | 'phone_system'

/** One code to dial. `{number}` stands for the assistant's number in the guide's `numberFormat`. */
export type DialCode = { code: string; when?: string }
export type DialSteps = { on: readonly DialCode[]; off: readonly DialCode[] }
/**
 * Numbered steps in an app, a web portal or the phone's settings. `{number}` is the assistant's number written out,
 * (503) 555-0142; `{digits}` is digits only with the country code, 15035550142, for systems that expect that.
 */
export type SettingSteps = { on: readonly string[]; off: readonly string[] }

type GuideBase = {
  id: string
  name: string
  kind: GuideKind
  /** Lowercase names a carrier lookup or a search may use for it (former names, the company behind it). */
  aliases: readonly string[]
  /** For a brand on another carrier's network: that network, in words. */
  network?: string
  /** What goes wrong with this line, in plain words for the owner. */
  pitfalls: readonly string[]
  /** Where the codes or steps come from: the carrier's own page first. */
  sources: readonly { url: string; label: string }[]
  /** Said next to the instructions, e.g. that a mode isn't offered and what to do instead. */
  note?: string
}

export type DialGuide = GuideBase & {
  how: 'dial'
  /** `ten`: 5035550142; `eleven`: 15035550142 (T-Mobile writes the 1 in front). */
  numberFormat: 'ten' | 'eleven'
  modes: Partial<Record<ForwardingMode, DialSteps>>
  /** Codes that show whether forwarding is on (the network answers on screen). */
  check?: readonly DialCode[]
  /** Seconds the phone rings before a missed call forwards, when the code sets it. */
  ringSeconds?: number
}

export type SettingsGuide = GuideBase & {
  how: 'settings'
  /** Where the setting lives, e.g. "the RingCentral app or admin portal". */
  where: string
  modes: Partial<Record<ForwardingMode, SettingSteps>>
  /** Where to see whether it is on. */
  check?: string
}

export type ForwardingGuide = DialGuide | SettingsGuide

export const guideKindLabels: Record<GuideKind, string> = {
  mobile: 'Cell phone',
  landline: 'Landline or cable phone',
  phone_system: 'Phone system or app',
}

// Sources used by several guides.
const GSM_STANDARD = {
  url: 'https://www.3gpp.org/DynaReport/22030.htm',
  label: '3GPP TS 22.030 (the GSM forwarding codes)',
}
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

/** The GSM codes (AT&T, T-Mobile and their brands): no answer with a ring time, busy, unreachable; every call. */
const gsmModes = (ringSeconds: number | null, all: DialSteps): DialGuide['modes'] => ({
  forward_conditional: {
    on: [
      ringSeconds
        ? { code: `**61*{number}**${ringSeconds}#`, when: `Not answered within ${ringSeconds} seconds` }
        : { code: '**61*{number}#', when: 'Not answered' },
      { code: '**67*{number}#', when: 'Busy' },
      { code: '**62*{number}#', when: 'Phone off or no signal' },
    ],
    off: [{ code: '##61#' }, { code: '##67#' }, { code: '##62#' }],
  },
  forward_all: all,
})
const GSM_CHECK: readonly DialCode[] = [
  { code: '*#61#', when: 'Not answered' },
  { code: '*#21#', when: 'Every call' },
]

/** The phone's own call forwarding menu, for carriers that publish no codes. */
const phoneMenuModes: SettingsGuide['modes'] = {
  forward_conditional: {
    on: [
      'Android: open the Phone app › ⋮ › Settings › Calling accounts (or Supplementary services) › Call forwarding.',
      'Tap “When unanswered”, enter {number} and turn it on. Do the same for “When busy” and “When unreachable”.',
      'iPhone has no setting for missed calls only: use Every call, or ask your carrier for its “conditional call forwarding” code.',
    ],
    off: ['Turn “When unanswered”, “When busy” and “When unreachable” off in the same place.'],
  },
  forward_all: {
    on: [
      'iPhone: Settings › Apps › Phone › Call Forwarding (older iPhones: Settings › Phone › Call Forwarding).',
      'Turn Call Forwarding on, tap Forward To and enter {number}.',
      'Android: Phone app › ⋮ › Settings › Calling accounts › Call forwarding › “Always forward” › {number}.',
    ],
    off: ['Turn Call Forwarding (or “Always forward”) off in the same place.'],
  },
}

/** Every guide, mobile first, then landlines, then phone systems. The first one is the default choice. */
export const forwardingGuides: readonly ForwardingGuide[] = [
  // ---- Mobile: Verizon and brands on its network ----
  {
    id: 'verizon',
    name: 'Verizon',
    kind: 'mobile',
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
    aliases: ['other', 'mobile', 'cell'],
    how: 'settings',
    where: 'your phone’s settings',
    modes: phoneMenuModes,
    note: 'Most carriers also have codes: search for your carrier and “conditional call forwarding”.',
    pitfalls: [],
    sources: [ATT_IPHONE, ATT_ANDROID],
  },
  // ---- Landline and cable business lines: dialled from the desk phone ----
  {
    id: 'comcast-business',
    name: 'Comcast Business Voice',
    kind: 'landline',
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
  // ---- Phone systems and apps: a setting, not a code ----
  {
    id: 'ringcentral',
    name: 'RingCentral',
    kind: 'phone_system',
    aliases: ['ringcentral', 'ringex', 'ring central'],
    how: 'settings',
    where: 'the RingCentral app or admin portal',
    modes: {
      forward_conditional: {
        on: [
          'RingCentral app › Settings › Phone › Incoming call rules › Incoming calls (admins: Admin Portal › Users › the user › Phone › Incoming call rules).',
          'Ring settings: 4 rings (about 20 seconds) on your devices.',
          '“If no one answers” › “Forward the call” › {number}.',
          'Save.',
        ],
        off: ['Set “If no one answers” back to voicemail in the same place.'],
      },
      forward_all: {
        on: ['RingCentral app › your profile › Call rules › “Forward all calls” › {number}.'],
        off: ['Turn “Forward all calls” off in the same place.'],
      },
    },
    check: 'RingCentral app › Settings › Phone › Incoming call rules',
    pitfalls: [
      'Turn off “Screen callers” / “Ask me if I want to answer”: its press-1 prompt stops your assistant.',
      '“Forward all calls” only shows when your admin allows call handling changes.',
    ],
    sources: [
      {
        url: 'https://support.ringcentral.com/article-v2/Setting-up-how-incoming-calls-are-handled.html?brand=RingCentral&product=RingEX&language=en_US',
        label: 'RingCentral: incoming call rules',
      },
    ],
  },
  {
    id: 'google-voice',
    name: 'Google Voice',
    kind: 'phone_system',
    aliases: ['google voice', 'gv', 'google'],
    how: 'settings',
    where: 'voice.google.com',
    modes: {
      forward_all: {
        on: [
          'voice.google.com › Settings › Account › Linked numbers › New linked number › {number}.',
          'Verify it: your assistant answers the verification call.',
          'Settings › Calls › Call forwarding: turn the linked number on.',
        ],
        off: ['Settings › Calls › Call forwarding: turn the linked number off.'],
      },
    },
    check: 'voice.google.com › Settings › Calls › Call forwarding',
    note: 'Google Voice rings linked numbers together; it can’t forward only the calls you miss. Forward every call, or give your assistant its own new number.',
    pitfalls: ['Google doesn’t support forwarding to automated systems; turn off call screening, or use a new number.'],
    sources: [{ url: 'https://support.google.com/voice/answer/165221?hl=en', label: 'Google Voice: forward calls' }],
  },
  {
    id: 'grasshopper',
    name: 'Grasshopper',
    kind: 'phone_system',
    aliases: ['grasshopper'],
    how: 'settings',
    where: 'the Grasshopper admin portal',
    modes: {
      forward_conditional: {
        on: [
          'Grasshopper admin portal › Extensions (or Call management › Extensions) › Edit on the extension.',
          'Add a forwarding number › {number}.',
          '“How should Grasshopper handle calls?” › “Calls will connect to you as soon as you pick up”.',
          'Options › ring order “In order”: your own phone first, then {number} › Save.',
        ],
        off: ['Remove {number} from the forwarding numbers in the same place.'],
      },
      forward_all: {
        on: [
          'Grasshopper admin portal › Extensions › Edit on the extension.',
          'Add a forwarding number › {number}, and make it the only one turned on.',
          '“Calls will connect to you as soon as you pick up” › Save.',
        ],
        off: ['Turn your own forwarding number back on and remove {number} in the same place.'],
      },
    },
    check: 'Grasshopper admin portal › Extensions',
    pitfalls: [
      'The “announce” options add a “press 1 to accept” prompt your assistant can’t answer: use “connect as soon as you pick up”.',
    ],
    sources: [
      {
        url: 'https://support.grasshopper.com/help/forward-incoming-calls-for-an-extension',
        label: 'Grasshopper: forward calls for an extension',
      },
    ],
  },
  {
    id: 'ooma-office',
    name: 'Ooma Office',
    kind: 'phone_system',
    aliases: ['ooma', 'ooma office'],
    how: 'settings',
    where: 'the Ooma Office portal or app',
    modes: {
      forward_all: {
        on: [
          'Ooma Office portal › Settings › Call Handling (desktop app: your name › Settings › Devices).',
          '“When a call comes in” › “Forward it immediately”.',
          '“Forward to” › “My forwarding number” › {number}.',
          'Leave “Require key press on answer” off › Save.',
        ],
        off: ['Set “When a call comes in” back to ringing your devices in the same place. From an Ooma phone: *74.'],
      },
    },
    note: 'Ooma documents forwarding every call; for missed calls only, ask Ooma or forward every call.',
    pitfalls: ['“Require key press on answer” adds a press-1 prompt your assistant can’t answer.'],
    sources: [
      {
        url: 'https://www.ooma.com/small-business-phone-systems/how-to/how-to-turn-call-forwarding-on-and-off/',
        label: 'Ooma Office: call forwarding',
      },
    ],
  },
  {
    id: 'vonage',
    name: 'Vonage Business',
    kind: 'phone_system',
    aliases: ['vonage', 'vonage business communications', 'nexmo'],
    how: 'settings',
    where: 'the Vonage Admin Portal or app.vonage.com',
    modes: {
      forward_conditional: {
        on: [
          'Admin Portal › Phone System › Extensions › pencil on the extension.',
          'Call Forwarding › Forward Calls on › “Follow Me”.',
          'Step 1: the extension, 20 seconds. Step 2: {number}, 30 seconds or more.',
          'Caller ID: “Originating Caller ID” › Save.',
        ],
        off: ['In the same place, turn Forward Calls off › Save.'],
      },
      forward_all: {
        on: [
          'Admin Portal › Phone System › Extensions › pencil › Call Forwarding › Forward Calls on › {number} › Save.',
        ],
        off: ['In the same place, turn Forward Calls off › Save.'],
      },
    },
    check: 'Admin Portal › Phone System › Extensions › Call Forwarding',
    pitfalls: ['Choose “Originating Caller ID”, so your assistant sees who is calling.'],
    sources: [
      { url: 'https://businesssupport.vonage.com/articles/answer/Follow-Me-24816', label: 'Vonage: Follow Me' },
      {
        url: 'https://businesssupport.vonage.com/articles/answer/Call-Forwarding-24813',
        label: 'Vonage: call forwarding',
      },
    ],
  },
  {
    id: 'dialpad',
    name: 'Dialpad',
    kind: 'phone_system',
    aliases: ['dialpad'],
    how: 'settings',
    where: 'Dialpad settings',
    modes: {
      forward_conditional: {
        on: [
          'Dialpad › Office Settings › Main Line › Business Hours & Call Routing › Edit Call Routing.',
          'Fallback Options › forward to {number}.',
          'An outside number as fallback is turned on by Dialpad support: ask them first.',
        ],
        off: ['Set the fallback back to voicemail in the same place.'],
      },
    },
    note: 'Dialpad has no setting for a person’s missed calls to an outside number; the main line’s fallback is the way.',
    pitfalls: [
      'Dialpad asks “press 1” when a forwarded call is answered within 5 seconds, and it can’t be fully turned off. Your assistant answers fast, so test it.',
    ],
    sources: [
      { url: 'https://help.dialpad.com/docs/call-forwarding', label: 'Dialpad: call forwarding' },
      { url: 'https://help.dialpad.com/docs/forwarding-number-faqs', label: 'Dialpad: forwarding number FAQs' },
    ],
  },
  {
    id: '8x8',
    name: '8x8',
    kind: 'phone_system',
    aliases: ['8x8 work', 'eight by eight'],
    how: 'settings',
    where: 'the 8x8 Admin Console',
    modes: {
      forward_conditional: {
        on: [
          '8x8 Admin Console › Users › pencil next to the user.',
          'Call forwarding rules › Edit.',
          '“When User does not Answer the Call”: ring time 20 seconds › “Forward Directly To” › {digits}.',
          'The same for “When User is Busy” and “When Internet Connection is Down” › Save.',
        ],
        off: ['In the same place, set the rules back to voicemail › Save.'],
      },
      forward_all: {
        on: ['8x8 Admin Console › Users › pencil › Call forwarding rules › “Forward all Calls” › {digits} › Save.'],
        off: ['In the same place, turn “Forward all Calls” off › Save.'],
      },
    },
    check: '8x8 Admin Console › Users › the user › Call forwarding rules',
    pitfalls: [
      'Forwarding set on a desk phone overrides the Admin Console.',
      'Enter the number with the 1 in front, as shown.',
    ],
    sources: [
      {
        url: 'https://help.8x8.com/docs/set-up-call-forwarding-in-8x8-admin-console.md',
        label: '8x8: call forwarding in Admin Console',
      },
    ],
  },
  {
    id: 'nextiva',
    name: 'Nextiva',
    kind: 'phone_system',
    aliases: ['nextiva', 'nextivaone'],
    how: 'settings',
    where: 'the Nextiva voice portal or NextivaONE',
    modes: {
      forward_conditional: {
        on: [
          'Voice portal › Users › the user › Actions › Voice Settings (NextivaONE: your picture › My settings › Calls › When unanswered).',
          'Forwarding › “Call forwarding (unanswered)”.',
          '{number}, 4 rings › Save.',
        ],
        off: ['Turn “Call forwarding (unanswered)” off in the same place.'],
      },
      forward_all: {
        on: [
          'Voice portal › Users › the user › Voice Settings › Forwarding › “Call forwarding always” › {number} › Save.',
        ],
        off: ['Turn “Call forwarding always” off in the same place.'],
      },
    },
    check: 'Voice portal › Users › the user › Voice Settings › Forwarding',
    pitfalls: ['It forwards calls to the user, not calls to a call group or call center.'],
    sources: [
      { url: 'https://help.nextiva.com/article/call-forward-no-answer', label: 'Nextiva: call forward no answer' },
      { url: 'https://help.nextiva.com/article/call-forwarding-always', label: 'Nextiva: call forwarding always' },
    ],
  },
  {
    id: 'quo',
    name: 'Quo (OpenPhone)',
    kind: 'phone_system',
    aliases: ['openphone', 'open phone', 'quo'],
    how: 'settings',
    where: 'Quo settings',
    modes: {
      forward_conditional: {
        on: [
          'Quo › Settings › Workspace › Phone numbers › your number › Call flow › Edit call flow.',
          '“Ring users”: 20 seconds.',
          'Add a “Forward call” step after it › {number}.',
          'Save and enable the call flow.',
        ],
        off: ['In the same place, remove the “Forward call” step or enable the default call flow.'],
      },
      forward_all: {
        on: [
          'Quo › Settings › Workspace › Phone numbers › your number › Call flow.',
          '“Forward all calls” › {number} › enable the call flow.',
        ],
        off: ['Enable the default call flow in the same place.'],
      },
    },
    check: 'Quo › Settings › Workspace › Phone numbers › your number › Call flow',
    pitfalls: ['Forwarded calls aren’t recorded in Quo and don’t fall back to Quo voicemail.'],
    sources: [
      {
        url: 'https://support.quo.com/core-concepts/administration/call-flows/call-forwarding',
        label: 'Quo: call forwarding',
      },
    ],
  },
  {
    id: 'zoom-phone',
    name: 'Zoom Phone',
    kind: 'phone_system',
    aliases: ['zoom', 'zoom phone', 'zoom workplace'],
    how: 'settings',
    where: 'the Zoom Workplace app',
    modes: {
      forward_conditional: {
        on: [
          'Add {number} as an external contact in Zoom first.',
          'Zoom Workplace app › your picture › Settings › Phone › Voicemail and forwarding › Business hours.',
          '“When a call goes unanswered” › Forward to external contact › {number}. The same for “When I’m busy on another call”.',
          'The same under Closed hours.',
        ],
        off: ['Set “When a call goes unanswered” back to voicemail in the same place.'],
      },
    },
    check: 'Zoom Workplace › Settings › Phone › Voicemail and forwarding',
    note: 'Zoom documents forwarding unanswered and busy calls; for every call, ask your Zoom admin.',
    pitfalls: [
      'Leave “Send unanswered calls to my voicemail” off: it makes the forwarded call ask for a key press.',
      'Your Zoom user needs its own phone number to forward outside.',
    ],
    sources: [
      {
        url: 'https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0083324',
        label: 'Zoom Phone: call forwarding',
      },
    ],
  },
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

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim()

/**
 * The guide for a carrier name as a lookup or the owner writes it ("Verizon Wireless", "T-Mobile USA, Inc.",
 * "OpenPhone"), or undefined. Matches the name or an alias as whole words, the longest match first, so
 * "Spectrum Mobile" finds Spectrum Mobile and not Spectrum Business.
 */
export function forwardingGuideForCarrier(name: string | null | undefined): ForwardingGuide | undefined {
  const text = ` ${normalize(name ?? '')} `
  if (!text.trim()) return undefined
  let best: { guide: ForwardingGuide; length: number } | undefined
  for (const guide of forwardingGuides) {
    if (guide.id === 'other-mobile') continue
    for (const candidate of [guide.name, ...guide.aliases]) {
      const words = normalize(candidate)
      if (words && text.includes(` ${words} `) && words.length > (best?.length ?? 0))
        best = { guide, length: words.length }
    }
  }
  return best?.guide
}

/**
 * Guides matching what was typed in the picker, best first: the name starting with it, then a word of the name,
 * then a former name or alias, then the network or kind ("verizon network", "landline"). Matches start at a word,
 * so "t-mob" finds T-Mobile and its brands, not "AT&T Mobility". All guides for an empty search.
 */
export function searchForwardingGuides(typed: string): ForwardingGuide[] {
  const query = normalize(typed)
  if (!query) return [...forwardingGuides]
  const startsWord = (text: string) => ` ${normalize(text)}`.includes(` ${query}`)
  const rank = (g: ForwardingGuide) => {
    if (normalize(g.name).startsWith(query)) return 0
    if (startsWord(g.name)) return 1
    if (g.aliases.some(startsWord)) return 2
    if (startsWord(g.network ?? '') || startsWord(guideKindLabels[g.kind])) return 3
    return null
  }
  return forwardingGuides
    .map((g, i) => ({ g, i, r: rank(g) }))
    .filter((m): m is { g: ForwardingGuide; i: number; r: number } => m.r !== null)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(m => m.g)
}

/** The assistant's number as the guide's codes expect it: 10 digits, or 11 with the 1 in front. */
export function guideNumber(guide: DialGuide, e164: string): string {
  const ten = e164.replace(/^\+1/, '').replace(/\D/g, '')
  return guide.numberFormat === 'eleven' ? `1${ten}` : ten
}

/** A `tel:` link that opens the phone's dialer with the code filled in (`#` must be written as %23). */
export const dialHref = (code: string) => `tel:${encodeURIComponent(code.replace(/\s+/g, ''))}`

export type ResolvedCode = { code: string; when?: string; href: string }
export type ForwardingInstructions =
  | { how: 'dial'; on: ResolvedCode[]; off: ResolvedCode[]; check: ResolvedCode[] }
  | { how: 'settings'; where: string; on: string[]; off: string[]; check: string | null }

/**
 * What to dial or change to forward to `e164` in `mode`, and how to undo and check it; null when the guide has no
 * way for that mode (its `note` says what to do instead).
 */
export function forwardingInstructions(
  guide: ForwardingGuide,
  mode: ForwardingMode,
  e164: string,
): ForwardingInstructions | null {
  if (guide.how === 'dial') {
    const steps = guide.modes[mode]
    if (!steps) return null
    const number = guideNumber(guide, e164)
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
  const digits = `1${e164.replace(/^\+1/, '').replace(/\D/g, '')}`
  const fill = (s: string) => s.replaceAll('{number}', written).replaceAll('{digits}', digits)
  return {
    how: 'settings',
    where: guide.where,
    on: steps.on.map(fill),
    off: steps.off.map(fill),
    check: guide.check ?? null,
  }
}

/** +15035550142 → (503) 555-0142, the way US settings pages take it. */
function writtenNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}

/** The modes a guide has instructions for. */
export const guideModes = (guide: ForwardingGuide): ForwardingMode[] =>
  (['forward_conditional', 'forward_all'] as const).filter(m => !!guide.modes[m])
