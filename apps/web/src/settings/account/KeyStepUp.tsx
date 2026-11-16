// The confirmation a new personal key needs (owner-step-up.ts personalKeyStepUpNeeded): a sign-in from the last
// 10 minutes, or, with a passkey, a passkey or authenticator confirmation from the last 10 minutes. Shared by
// Account settings › Personal API keys (CreateKey) and the OAuth consent page of an MCP client (ConnectAgent), whose
// Allow makes such a key too. The action runs; on the server's refusal code this asks for the step and runs it again.
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { passkeySupported } from '../../auth.ts'
import { checkAuthenticator } from '../../authenticator-api.ts'
import { brandName } from '../../brand.ts'
import { signInAgain } from '../../localData.ts'
import { AuthError } from '../../ui/AuthError.tsx'
import { Input } from '../../ui/form.tsx'
import { Button } from '../../ui/kit.tsx'
import { Field } from '../fields.tsx'
import { confirmWithPasskey } from './account-api.ts'
import { authenticatorErrorText } from './authenticator.tsx'

/** The words that differ per page: what the confirmation is for. */
export type StepUpTexts = { withEither: MessageKey; withPasskey: MessageKey }

export type KeyStepUp = ReturnType<typeof useKeyStepUp>

/**
 * `run` makes the key (personalKey.create, oauth.approve); `failed` turns any other error into the text to show.
 * `submit` is the form's: the action, the passkey, or the typed authenticator code and then the action.
 */
export function useKeyStepUp(run: () => Promise<void>, failed: (err: unknown) => string) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [signInFirst, setSignInFirst] = useState(false)
  const [confirm, setConfirm] = useState<{ authenticator: boolean } | null>(null)
  const [code, setCode] = useState('')

  async function attempt() {
    setError(null)
    setSignInFirst(false)
    try {
      await run()
    } catch (err) {
      const { code: refusal, authenticator } = err as { code?: unknown; authenticator?: unknown }
      if (refusal === 'SIGN_IN_AGAIN') setSignInFirst(true)
      else if (refusal === 'PASSKEY_STEP_UP_REQUIRED') setConfirm({ authenticator: authenticator === true })
      else setError(failed(err))
    }
  }

  /** Runs one step (a confirmation, then the action) with the form busy. */
  async function busyWith(work: () => Promise<void>) {
    setSaving(true)
    try {
      await work()
    } finally {
      setSaving(false)
    }
  }

  // confirmWithPasskey: another account's passkey signs out instead of acting for that account.
  const withPasskey = () =>
    busyWith(async () => {
      setError(null)
      try {
        await confirmWithPasskey()
      } catch (err) {
        return setError((err as Error).message)
      }
      await attempt()
    })

  function submit() {
    if (saving) return
    const typed = code.trim()
    if (confirm && !typed) return void withPasskey()
    if (!confirm) return void busyWith(attempt)
    void busyWith(async () => {
      setError(null)
      try {
        await checkAuthenticator(typed)
      } catch (err) {
        return setError(authenticatorErrorText(err, t))
      }
      setCode('')
      await attempt()
    })
  }

  return { error, saving, signInFirst, confirm, code, setCode, submit }
}

/** What the step asks for: the passkey (or code) prompt, the https note, the authenticator code field. */
export function StepUpFields({ stepUp, texts, id }: { stepUp: KeyStepUp; texts: StepUpTexts; id: string }) {
  const t = useT()
  const { confirm, code, setCode, saving } = stepUp
  if (!confirm) return null
  return (
    <>
      <p className="help" role="status">
        {t(confirm.authenticator ? texts.withEither : texts.withPasskey)}
      </p>
      {!passkeySupported() && <AuthError message={t('admin.stepUp.httpsNeeded', { brand: brandName() })} />}
      {confirm.authenticator && (
        <Field id={id} label={t('account.authenticator.code')}>
          <Input
            id={id}
            placeholder={t('account.authenticator.codePlaceholder')}
            value={code}
            onChange={e => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            disabled={saving}
          />
        </Field>
      )}
    </>
  )
}

/**
 * The form's main button for the step it is at: sign in again, confirm with the passkey, confirm with the code, or
 * the action itself (`label`, `busyLabel` while it runs, `tip` its tooltip).
 */
export function StepUpSubmit({
  stepUp,
  label,
  busyLabel,
  tip,
  shortcut,
  disabled,
}: {
  stepUp: KeyStepUp
  label: string
  busyLabel: string
  tip?: string
  shortcut?: string[]
  disabled?: boolean
}) {
  const t = useT()
  const { signInFirst, confirm, code, saving } = stepUp
  if (signInFirst)
    return (
      <Button variant="primary" title={t('account.signInAgain.title')} onClick={() => void signInAgain()}>
        {t('account.signInAgain.button')}
      </Button>
    )
  if (confirm && !code.trim())
    return (
      <Button
        busy={saving}
        variant="primary"
        type="submit"
        disabled={saving || disabled || !passkeySupported()}
        title={t('admin.stepUp.confirm.tip')}
      >
        {saving ? t('admin.stepUp.waiting') : t('admin.stepUp.confirm.button')}
      </Button>
    )
  if (confirm)
    return (
      <Button busy={saving} type="submit" variant="primary" disabled={saving || disabled}>
        {t('account.apiKeys.confirm.withCode')}
      </Button>
    )
  return (
    <Button busy={saving} type="submit" variant="primary" disabled={saving || disabled} title={tip} shortcut={shortcut}>
      {saving ? busyLabel : label}
    </Button>
  )
}
