// The "type the name to confirm" field of a heavy step (DangerConfirmDialog: deleting or disabling a workspace,
// releasing a client, removing the partner): the label says what to type with the name in quotes, a Copy button
// right next to it (a long workspace name is hard to type), then the field, which takes a paste like any other.
import { T, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { FormField, Input } from './form.tsx'
import { copyText } from './HelpTip.tsx'
import { Button } from './kit.tsx'

/** Puts the name on the clipboard exactly as shown, nothing added or trimmed; says whether it worked. */
export const copyName = (name: string, clipboard?: Pick<Clipboard, 'writeText'>) =>
  clipboard ? copyText(name, clipboard) : copyText(name)

type Props = {
  id: string
  /** The name to type, shown as is. */
  name: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function ConfirmByName({ id, name, value, onChange, disabled }: Props) {
  const t = useT()
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copied === 'idle') return
    const timer = setTimeout(() => setCopied('idle'), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  const feedback =
    copied === 'copied' ? t('common.copy.copied') : copied === 'failed' ? t('common.copy.selectIt') : null
  return (
    <FormField
      id={id}
      className="confirm-name"
      label={
        <T
          k="common.dangerConfirm.typeToConfirm"
          values={{ text: name, b: chunks => <b className="confirm-name-value">{chunks}</b> }}
        />
      }
      labelAfter={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={copied === 'copied' ? 'check' : 'copy'}
            className="confirm-name-copy"
            // Icon only, so the label beside it never reflows; the tooltip and the live line say "Copied".
            title={feedback ?? t('common.copy.copy')}
            aria-label={t('common.dangerConfirm.copyName')}
            onClick={() => void copyName(name).then(setCopied)}
          />
          <span className="sr-only" aria-live="polite">
            {feedback ?? ''}
          </span>
        </>
      }
    >
      <Input
        id={id}
        value={value}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    </FormField>
  )
}
