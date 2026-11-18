// The call quality levels as the assistant editor shows them (voice.options `callQuality`,
// packages/actions/src/usage-level.ts): their names and, where there are prices, the price a minute.
import { CALL_QUALITY_LABELS, type CallQuality, type CallQualityLevelOption } from '@linedesk/actions'
import { i18n } from '../i18n/index.tsx'

/** The value of the "Default" option (the server's model for the level). */
export const DEFAULT_CHOICE = ''

/** A price a minute, given in cents as the prices are decided, shown in dollars ("$0.10"), never with the cent sign. */
export const pricePerMinute = (cents: number) => i18n().format.rate(cents / 100, 'USD')

/** A level's name: a product name, the same in every language. */
export const levelName = (level: CallQuality) => CALL_QUALITY_LABELS[level]

/** "$0.10 a minute", or nothing where there are no prices (a partner's client, no bill, self-hosted). */
export const levelPrice = (option: Pick<CallQualityLevelOption, 'centsPerMinute'>) =>
  option.centsPerMinute === null
    ? undefined
    : i18n().t('settings.voice.quality.perMinute', { price: pricePerMinute(option.centsPerMinute) })
