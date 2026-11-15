// A passkey confirmation in place of an action: a workspace owner deleting their workspace confirms with their passkey
// (apps/api/src/owner-step-up.ts). When the server asks for it (PASSKEY_STEP_UP_REQUIRED), this dialog signs in with
// the passkey (a new session) and the action runs again. Server admin as a whole needs the passkey check before it
// opens (SecondFactorPrompt.tsx); its requests answer SECOND_FACTOR_REQUIRED instead, so no admin action asks here.
import { useEffect, useState } from 'react'
import { passkeySupported, signInWithPasskey } from '../auth.ts'
import { authErrorMessage } from '../sign-in-code.ts'
import { AuthError } from '../ui/AuthError.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { brandName } from '../brand.ts'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

export const PASSKEY_STEP_UP_REQUIRED = 'PASSKEY_STEP_UP_REQUIRED'
/** `confirm`: sign in with your passkey; `enrol`: add a first passkey (enrolment code). */
export type StepUp = 'confirm' | 'enrol'

/** Thrown by the admin requests when the server answers PASSKEY_STEP_UP_REQUIRED. */
export class StepUpRequired extends Error {
  readonly stepUp: StepUp
  constructor(message: string, stepUp: StepUp) {
    super(message)
    this.stepUp = stepUp
  }
}

/** The step-up a refusal asks for, or null when it is another refusal. */
export function stepUpOf(json: { code?: unknown; stepUp?: unknown } | null): StepUp | null {
  if (json?.code !== PASSKEY_STEP_UP_REQUIRED) return null
  return json.stepUp === 'enrol' ? 'enrol' : 'confirm'
}

/** The command that prints an enrolment code on the server, named where an admin without a passkey adds the first. */
const ENROL_COMMAND = 'user:passkeys --enrol'

/** Why an action that needed a passkey did not run, or null when `err` is not a step-up refusal. */
export function stepUpRefusalText(err: unknown): string | null {
  if (!(err instanceof StepUpRequired)) return null
  const { t } = i18n()
  return err.stepUp === 'enrol'
    ? t('admin.stepUp.refused.enrol', { command: ENROL_COMMAND })
    : t('admin.stepUp.refused.confirm')
}

type Request = { stepUp: StepUp; what: string; done: (confirmed: boolean) => void }

/**
 * Step-ups waiting for the dialog, oldest first: two at once (a double click, two rows) never leave
 * one waiting forever. One passkey sign-in confirms every waiting request; Cancel answers only the shown one.
 */
const queue: Request[] = []
let render: (() => void) | null = null

/** Answers the shown request: confirmed answers every waiting one (the session is now passkey-confirmed). */
export function answer(confirmed: boolean) {
  const answered = confirmed ? queue.splice(0) : queue.splice(0, 1)
  for (const request of answered) request.done(confirmed)
  render?.()
}

/** Runs `run`; when the server asks for a passkey, asks for it (saying `what` it is for) and runs `run` again. */
export async function withPasskeyStepUp<T>(run: () => Promise<T>, what: string): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (!(e instanceof StepUpRequired) || !render) throw e
    const confirmed = await new Promise<boolean>(done => {
      queue.push({ stepUp: e.stepUp, what, done })
      render?.()
    })
    if (!confirmed) throw e
    return run()
  }
}

/** Connects the dialog (it re-renders on every change); the returned detach cancels what still waits. */
export function attachStepUpDialog(rerender: () => void): () => void {
  render = rerender
  return () => {
    render = null
    for (const request of queue.splice(0)) request.done(false)
  }
}

/** The request the dialog shows, if any. */
export const shownStepUp = (): Readonly<Request> | undefined => queue[0]

/** Mounted once in the admin area: the dialog withPasskeyStepUp opens. Leaving Server admin cancels what waits. */
export function PasskeyStepUpHost() {
  const [, setVersion] = useState(0)
  useEffect(() => attachStepUpDialog(() => setVersion(v => v + 1)), [])
  const request = shownStepUp()
  if (!request) return null
  return request.stepUp === 'enrol' ? (
    <EnrolFirst what={request.what} onClose={answer} />
  ) : (
    <ConfirmPasskey what={request.what} onClose={answer} />
  )
}

/** The dialog's line under the title: what is confirmed, then why a passkey ("Delete workspace Riverside Electric. …"). */
export function stepUpReason(what: string) {
  const { t, locale } = i18n()
  const first = what.charAt(0).toLocaleUpperCase(locale)
  return t('admin.stepUp.reason', { what: `${first}${what.slice(1)}` })
}

function ConfirmPasskey({ what, onClose }: { what: string; onClose: (confirmed: boolean) => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await signInWithPasskey().catch((error: unknown) => ({ error }))
    setBusy(false)
    if (res.error) return setError(authErrorMessage(res.error))
    onClose(true)
  }
  return (
    <Dialog
      title={t('admin.stepUp.confirm.title')}
      description={stepUpReason(what)}
      size="sm"
      onClose={() => onClose(false)}
      onSubmit={e => {
        e.preventDefault()
        void confirm()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>
            {t('common.action.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !passkeySupported()}
            title={t('admin.stepUp.confirm.tip')}
          >
            {busy ? t('admin.stepUp.waiting') : t('admin.stepUp.confirm.button')}
          </Button>
        </>
      }
    >
      {!passkeySupported() && <AuthError message={t('admin.stepUp.httpsNeeded', { brand: brandName() })} />}
      {error && <AuthError message={error} />}
    </Dialog>
  )
}

function EnrolFirst({ what, onClose }: { what: string; onClose: (confirmed: boolean) => void }) {
  const t = useT()
  return (
    <Dialog
      title={t('admin.stepUp.enrol.title', { what })}
      description={t('admin.stepUp.enrol.description', { command: ENROL_COMMAND })}
      size="sm"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>
            {t('common.action.cancel')}
          </Button>
          <Button
            variant="primary"
            title={t('admin.stepUp.enrol.tip')}
            onClick={() => {
              onClose(false)
              window.location.hash = '#account/security'
            }}
          >
            {t('admin.stepUp.enrol.button')}
          </Button>
        </>
      }
    />
  )
}
