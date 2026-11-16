// The voice model and language model an assistant picks, with their level on Linedesk Cloud (voice.options `levels`,
// packages/actions/src/usage-level.ts): Standard, or Premium at a higher price a minute. Without billing (self-hosted)
// every choice is there, without labels. Premium choices the workspace may not use are shown, not pickable.
import type { LevelChoice, UsageLevelOptions, UsageTier } from '@linedesk/actions'
import type { SelectOption } from '../ui/controls.tsx'
import { i18n } from '../i18n/index.tsx'

/** The value of the "Default" option (the install's model). */
export const DEFAULT_CHOICE = ''

/** A price a minute, in cents as the prices are decided ("10¢"). */
export const pricePerMinute = (cents: number) => i18n().t('settings.voice.level.cents', { cents })

/** The level's tag next to a choice: "Standard" or "Premium, 10¢/min"; nothing without billing. */
export function levelTag(level: UsageTier | null, levels: UsageLevelOptions): string | undefined {
  if (!levels.billed || !level) return undefined
  const t = i18n().t
  return level === 'premium'
    ? t('settings.voice.level.premiumTag', { price: pricePerMinute(levels.premiumCentsPerMinute) })
    : t('settings.voice.level.standardTag')
}

function choiceOption(c: LevelChoice, levels: UsageLevelOptions): SelectOption<string> {
  const t = i18n().t
  return {
    value: c.id,
    label: c.name,
    description: c.allowed
      ? levelTag(c.level, levels)
      : t('settings.voice.level.premiumOff', { price: pricePerMinute(levels.premiumCentsPerMinute) }),
    ...(c.allowed ? {} : { disabled: true }),
  }
}

/**
 * The options of a picker: "Default (<what it stands for>)", then the choices in list order. `current`, when it is
 * not among them (saved before a list changed), is kept as the selected option, so the picker never shows a blank.
 */
export function levelOptions(
  choices: readonly LevelChoice[],
  defaultChoice: { id: string; level: UsageTier | null } | null | undefined,
  levels: UsageLevelOptions,
  current: string,
): SelectOption<string>[] {
  const t = i18n().t
  const named = choices.find(c => c.id === defaultChoice?.id)?.name ?? defaultChoice?.id
  const first: SelectOption<string> = {
    value: DEFAULT_CHOICE,
    label: named ? t('settings.voice.level.defaultNamed', { name: named }) : t('settings.voice.level.default'),
    description: levelTag(defaultChoice?.level ?? null, levels),
  }
  const options = [first, ...choices.map(c => choiceOption(c, levels))]
  if (current && !choices.some(c => c.id === current)) options.push({ value: current, label: current })
  return options
}

/** The level a call of the assistant gets with these choices: Premium when either is, else Standard (null: unknown). */
export function draftLevel(
  voice: { choices: readonly LevelChoice[]; picked: string; fallback: UsageTier | null },
  model: { choices: readonly LevelChoice[]; picked: string; fallback: UsageTier | null },
): UsageTier | null {
  const of = (p: typeof voice) => (p.picked ? (p.choices.find(c => c.id === p.picked)?.level ?? null) : p.fallback)
  const levels = [of(voice), of(model)]
  if (levels.includes('premium')) return 'premium'
  return levels.every(l => l === 'standard') ? 'standard' : null
}

/** Whether any Premium choice is greyed out: the hint about Allow Premium shows then. */
export const premiumLocked = (levels: UsageLevelOptions) =>
  levels.billed &&
  [...Object.values(levels.voiceModels).flat(), ...levels.models].some(c => c.level === 'premium' && !c.allowed)
