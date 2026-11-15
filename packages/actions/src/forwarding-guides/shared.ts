// The shape of a forwarding guide and the pieces several guides share (the GSM codes, the phone's own menu, common
// sources). The guides themselves are in ../forwarding-guides.ts (the US, "Other country") and in this folder, one
// file per region; ../forwarding-guides.ts puts them together and holds the logic.

/** How the business's own number reaches the assistant: only the calls it misses, or every call. */
export type ForwardingMode = 'forward_conditional' | 'forward_all'
export type GuideKind = 'mobile' | 'landline' | 'phone_system'

/** How a dialling guide writes the assistant's number into its codes (DialGuide.numberFormat). */
export type NumberFormat = 'ten' | 'eleven' | 'national' | 'nsn' | 'international'

/** One code to dial. `{number}` stands for the assistant's number in the guide's `numberFormat`. */
export type DialCode = { code: string; when?: string }
/** `off` is empty only where the carrier publishes no code to turn it off (its `note` says so). */
export type DialSteps = { on: readonly DialCode[]; off: readonly DialCode[] }
/**
 * Numbered steps in an app, a web portal or the phone's settings. `{number}` is the assistant's number written out,
 * (503) 555-0142; `{digits}` is digits only with the country code, 15035550142, for systems that expect that.
 */
export type SettingSteps = { on: readonly string[]; off: readonly string[] }

export type GuideBase = {
  /** US: a slug ('verizon'); elsewhere '<cc>-<slug>' in lowercase ('de-telekom', 'gb-other-mobile'). */
  id: string
  name: string
  kind: GuideKind
  /** The countries the guide is for (ISO 3166-1 alpha-2, uppercase); 'any': an app or phone system usable in every country. */
  countries: readonly string[] | 'any'
  /** Lowercase names a carrier lookup or a search may use for it (former names, the company behind it). */
  aliases: readonly string[]
  /** For a brand on another carrier's network: that network, in words. */
  network?: string
  /**
   * The carrier forwards only to numbers in its own country: an assistant number from another country doesn't work
   * (abroadWarning), not just costs more.
   */
  domesticOnly?: boolean
  /** What goes wrong with this line, in plain words for the owner. */
  pitfalls: readonly string[]
  /** Where the codes or steps come from: the carrier's own page first. */
  sources: readonly { url: string; label: string }[]
  /** Said next to the instructions, e.g. that a mode isn't offered and what to do instead. */
  note?: string
}

export type DialGuide = GuideBase & {
  how: 'dial'
  /**
   * How `{number}` is written (formatGuideNumber). `ten`: 5035550142; `eleven`: 15035550142 (T-Mobile writes the 1 in
   * front); `national`: the national format of the selected country, digits only with the trunk prefix (Germany:
   * 03012345678; UK: 02071234567); `nsn`: the national significant number, digits only, without trunk prefix or
   * country code (Brazil: 11987654321; India: 9812345678); `international`: + and the country code
   * (+493012345678). A number from another country than the one selected is always written internationally.
   */
  numberFormat: NumberFormat
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

/**
 * "Other country": a country the guides don't cover yet. Shows the standard GSM codes with the number written
 * internationally, and the phone's own settings. 'ZZ' is the code for an unknown region (as in libphonenumber).
 */
export const OTHER_COUNTRY = 'ZZ'

// Sources used by guides of several countries.
export const GSM_STANDARD = {
  url: 'https://www.3gpp.org/DynaReport/22030.htm',
  label: '3GPP TS 22.030 (the GSM forwarding codes)',
}
export const APPLE_CALL_FORWARDING = {
  url: 'https://support.apple.com/guide/iphone/set-up-call-forwarding-iph7405291c4/ios',
  label: 'Apple: set up call forwarding on iPhone',
}

/** The GSM codes (AT&T, T-Mobile and their brands): no answer with a ring time, busy, unreachable; every call. */
export const gsmModes = (ringSeconds: number | null, all: DialSteps): DialGuide['modes'] => ({
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
export const GSM_CHECK: readonly DialCode[] = [
  { code: '*#61#', when: 'Not answered' },
  { code: '*#21#', when: 'Every call' },
]

/** The phone's own call forwarding menu, for carriers that publish no codes. */
export const phoneMenuModes: SettingsGuide['modes'] = {
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
