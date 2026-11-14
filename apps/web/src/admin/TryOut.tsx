// "Try it": a real round trip with the provider in use (`provider.tryOut`), in its dialog (Server admin › Providers and
// the install walkthrough): a code emailed to the admin and typed back, a caller's question to the model, a sample call
// transcribed, the voice played, numbers listed without buying. It costs a little (a few tokens, a second of speech),
// unlike Test again, the free key check.
import { type ProviderCategory, type TryOutData, type TryOutKind, usAreaCode } from '@linedesk/actions'
import { type KeyboardEvent, useId, useState } from 'react'
import { AreaCodeInput } from '../settings/AreaCodeInput.tsx'
import { Input } from '../ui/form.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { problemText } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'
import { errorText } from './notify.ts'

/** The round trip of a category's provider in use, if it has one (the realtime model, sign-in and storage have none). */
export const tryKindOf = (category: ProviderCategory): TryOutKind | null =>
  category === 'email' || category === 'llm' || category === 'stt' || category === 'tts' || category === 'telephony'
    ? category
    : null

const tryLabels: Record<TryOutKind, string> = {
  email: 'Send me a test email',
  llm: 'Ask it a caller’s question',
  stt: 'Transcribe a sample call',
  tts: 'Hear the voice',
  telephony: 'Find available numbers',
}
const tryHelp: Record<TryOutKind, string> = {
  email:
    'Sends a six-digit code to your own address. Enter it here to confirm emails actually arrive, not just that they are sent.',
  llm: 'Asks the current model a short question a caller might ask, and shows the answer and how long it took.',
  stt: 'Transcribes a short sample recording and checks the result against what was said.',
  tts: 'Plays the greeting a caller would hear, right here in the page.',
  telephony: 'Looks up three available numbers in an area code. Nothing is purchased.',
}

/** Try it can run: the numbers lookup needs an area code from the list (the picker leaves it empty until then). */
export const canTry = (kind: TryOutKind, areaCode: string): boolean => kind !== 'telephony' || !!usAreaCode(areaCode)

/** The round trip of a part: one button, and what came back. */
export function TryOut({
  kind,
  primary,
  onTried,
}: {
  kind: TryOutKind
  primary: boolean
  onTried: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TryOutData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const areaId = useId()
  const [areaCode, setAreaCode] = useState('971')
  const [code, setCode] = useState('')
  const [confirmed, setConfirmed] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setProblem(null)
    setConfirmed(null)
    try {
      const input = kind === 'telephony' ? { kind, areaCode } : { kind }
      setResult((await runAdmin('provider.tryOut', input)) as TryOutData)
      await onTried()
    } catch (e) {
      setProblem(problemText(errorText(e)))
    } finally {
      setBusy(false)
    }
  }
  async function confirm() {
    setBusy(true)
    setProblem(null)
    try {
      const done = (await runAdmin('provider.confirmEmail', { code: code.trim() })) as { message: string }
      setConfirmed(done.message)
      setCode('')
      await onTried()
    } catch (e) {
      setProblem(problemText(errorText(e)))
    } finally {
      setBusy(false)
    }
  }

  const startTry = () => {
    if (!busy && canTry(kind, areaCode)) void run()
  }
  const startConfirm = () => {
    if (!busy && /^\d{6}$/.test(code.trim())) void confirm()
  }
  return (
    <section className="adm-try" aria-label="Try it">
      <div className="adm-try-head">
        <div>
          <b>Try it</b>
          <span className="help">{tryHelp[kind]}</span>
        </div>
        {/* Not a form: it sits inside the provider dialog's own form, so Enter here runs it, not Save. */}
        <div className="adm-try-form">
          {kind === 'telephony' && (
            // The searchable list of US area codes, as for a new number. Enter while the list is open picks a
            // code there; otherwise it runs Try it here.
            // biome-ignore lint/a11y/noStaticElementInteractions: only passes Enter on from the field inside
            <div className="adm-try-area" onKeyDown={e => onEnter(e, startTry)}>
              <AreaCodeInput id={areaId} label="US area code" value={areaCode} onChange={setAreaCode} />
            </div>
          )}
          <Button
            variant={primary && !result?.ok ? 'primary' : 'secondary'}
            busy={busy && !result}
            disabled={busy || !canTry(kind, areaCode)}
            onClick={startTry}
          >
            {result ? 'Try again' : tryLabels[kind]}
          </Button>
        </div>
      </div>

      {result && (
        <div className={cx('adm-try-result', result.ok ? 'ok' : 'bad')} role="status">
          <span className="adm-try-mark" aria-hidden>
            {result.ok ? <Icon name="check" size={12} /> : '!'}
          </span>
          <div className="adm-try-body">
            <span>{result.message}</span>
            {result.reply && (
              <blockquote className="adm-try-quote">
                <span className="help">Caller: Hi, my water heater is leaking. Can someone come out today?</span>
                {result.reply}
              </blockquote>
            )}
            {result.heard !== undefined && (
              <dl className="adm-try-heard">
                <dt>Said</dt>
                <dd>{result.expected}</dd>
                <dt>Heard</dt>
                <dd>{result.heard || '(nothing)'}</dd>
              </dl>
            )}
            {result.audio && (
              // biome-ignore lint/a11y/useMediaCaption: a spoken sample of the voice; its words are on the page
              <audio className="adm-try-audio" controls autoPlay src={result.audio} />
            )}
            {!!result.numbers?.length && (
              <ul className="adm-try-numbers">
                {result.numbers.map(n => (
                  <li key={n}>{formatNumber(n)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {kind === 'email' && result?.ok && !confirmed && (
        <div className="adm-try-form adm-try-code">
          <Input
            className="adm-try-code-input"
            aria-label="The code from the email"
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => onEnter(e, startConfirm)}
            autoFocus
          />
          <Button variant="primary" busy={busy} disabled={busy || code.trim().length !== 6} onClick={startConfirm}>
            Confirm
          </Button>
        </div>
      )}
      {confirmed && (
        <div className="adm-try-result ok" role="status">
          <span className="adm-try-mark" aria-hidden>
            <Icon name="check" size={12} />
          </span>
          <span>{confirmed}</span>
        </div>
      )}
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </section>
  )
}

/** Enter in a field of Try it runs it (and does not save the dialog around it). */
const onEnter = (e: KeyboardEvent, run: () => void) => {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
  e.preventDefault()
  e.stopPropagation()
  run()
}

const formatNumber = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164
}
