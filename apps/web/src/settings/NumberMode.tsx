// A number's "How calls reach <assistant>" field (Settings › Phone numbers › Manage): the mode's select, one line under
// it saying what the picked mode does, and a "?" that explains every mode in plain words (who dials which number, what
// rings, what the caller notices, when to pick it). The mode only labels the number and picks which forwarding steps
// the dialog shows; it never reroutes calls, so the help says that too.
import type { PhoneNumber } from '@linedesk/db/types'
import { phoneNumberModes } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { brandName } from '../brand.ts'
import { numberModeLabel } from '../onboarding/flow.ts'
import { Select } from '../ui/controls.tsx'
import { HelpTip } from '../ui/HelpTip.tsx'
import { Field } from './fields.tsx'

type PhoneNumberMode = PhoneNumber['mode']

/** One line under the field: what the picked mode does. */
export function useNumberModeHint(): (mode: PhoneNumberMode, name: string) => string {
  const t = useT()
  const hints: Record<PhoneNumberMode, (name: string) => string> = {
    forward_conditional: name => t('settings.phone.manage.modeHint.forwardConditional', { name }),
    forward_all: name => t('settings.phone.manage.modeHint.forwardAll', { name }),
    new: () => t('settings.phone.manage.modeHint.new'),
    ported: name => t('settings.phone.manage.modeHint.ported', { name }),
  }
  return (mode, name) => hints[mode](name)
}

/** What happens with each mode when a customer calls, and when to pick it. */
function useModeExplanation(): (mode: PhoneNumberMode, name: string) => string {
  const t = useT()
  const texts: Record<PhoneNumberMode, (name: string) => string> = {
    forward_conditional: name => t('settings.phone.manage.modeHelp.forwardConditional', { name }),
    forward_all: name => t('settings.phone.manage.modeHelp.forwardAll', { name }),
    new: name => t('settings.phone.manage.modeHelp.new', { name }),
    ported: name => t('settings.phone.manage.modeHelp.ported', { name, brand: brandName() }),
  }
  return (mode, name) => texts[mode](name)
}

/** Every mode with its explanation, in the select's order, then what changing it does. */
export function NumberModeHelp({ name }: { name: string }) {
  const t = useT()
  const explain = useModeExplanation()
  return (
    <span className="pn-mode-help">
      {phoneNumberModes.map(mode => (
        <span key={mode} className="pn-mode-help-item">
          <b>{numberModeLabel[mode]}</b>
          <span>{explain(mode, name)}</span>
        </span>
      ))}
      <span className="pn-mode-help-note">{t('settings.phone.manage.modeHelp.change')}</span>
    </span>
  )
}

type Props = {
  mode: PhoneNumberMode
  /** The assistant that answers the number. */
  name: string
  disabled: boolean
  onChange: (mode: PhoneNumberMode) => void
}

export function NumberModeField({ mode, name, disabled, onChange }: Props) {
  const t = useT()
  const hint = useNumberModeHint()
  const label = t('settings.phone.manage.callsReach', { name })
  return (
    <Field
      id="pn-mode"
      label={label}
      help={hint(mode, name)}
      labelAfter={
        <HelpTip label={t('settings.phone.manage.modeHelpLabel', { name })} text={<NumberModeHelp name={name} />} />
      }
    >
      <div>
        <Select
          id="pn-mode"
          value={mode}
          label={label}
          disabled={disabled}
          options={phoneNumberModes.map(m => ({ value: m, label: numberModeLabel[m] }))}
          onChange={onChange}
        />
      </div>
    </Field>
  )
}
