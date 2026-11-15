// One key for the whole Answering group (oneKey in packages/actions/src/provider-status.ts): an OpenAI key answers
// calls with its realtime model, and speech and model use it where they are empty. Shown only in Answering's empty
// state (Server admin › Providers and the install walkthrough). One server action: tested first, stored only when it
// works.
import { oneKey } from '@linedesk/actions'
import { useState } from 'react'
import { FormField, SecretInput } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { problemText } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'
import { errorText } from './notify.ts'
import { useT } from '@linedesk/i18n/react'

export function OneKey({ disabled, onDone }: { disabled: boolean; onDone: () => Promise<void> }) {
  const t = useT()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function use() {
    setBusy(true)
    setProblem(null)
    try {
      // One server action: the key is tested first and only stored when it works; a failing key changes nothing.
      // LIN-111: show providerFailureText(reason, 'OpenAI', 'admin') once the action answers with the test's reason.
      await runAdmin('provider.connectOneKey', { apiKey: key.trim() })
      setKey('')
      await onDone()
    } catch (err) {
      setProblem(problemText(errorText(err)))
    } finally {
      setBusy(false)
    }
  }
  const ready = !disabled && !busy && !!key.trim()
  return (
    <div className="adm-onekey">
      <b>{t('admin.oneKey.title')}</b>
      <p className="help">
        {t('admin.oneKey.intro', { provider: oneKey.label })} {oneKey.caveat} {oneKey.cost}
      </p>
      <ol className="adm-guide-steps">
        {oneKey.steps.map(step => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <form
        className="adm-onekey-form"
        onSubmit={e => {
          e.preventDefault()
          if (key.trim() && !busy) void use()
        }}
      >
        <FormField id="adm-onekey" label={t('admin.oneKey.keyLabel')}>
          <SecretInput id="adm-onekey" value={key} onChange={setKey} placeholder="sk-…" />
        </FormField>
        <Button
          busy={busy}
          type="submit"
          variant="primary"
          disabled={!ready}
          title={
            disabled
              ? t('admin.oneKey.tip.noSecrets', { name: 'SECRETS_KEY', file: '.env' })
              : ready
                ? t('admin.oneKey.tip.ready', { key: 'Enter' })
                : t('admin.oneKey.tip.paste')
          }
        >
          {busy ? t('admin.oneKey.connecting') : t('admin.oneKey.use')}
        </Button>
      </form>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
      <p className="help">
        <a href={oneKey.url} target="_blank" rel="noreferrer">
          {t('admin.oneKey.openKeys')}
        </a>
      </p>
    </div>
  )
}
