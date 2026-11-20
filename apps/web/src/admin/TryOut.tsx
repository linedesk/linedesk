// "Try it": a real round trip with the provider in use (`provider.tryOut`), in its dialog (Server admin › Providers and
// the install walkthrough): a code emailed to the admin and typed back, a caller's question to the model, a sample call
// transcribed, the voice played, numbers listed without buying. It costs a little (a few tokens, a second of speech),
// unlike Test again, the free key check.
import {
  buyableAreaCode,
  NUMBER_BUY_COUNTRIES,
  phoneCountryName,
  type ProviderCategory,
  type TryOutData,
  type TryOutKind,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useId, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { AreaCodeInput } from '../settings/AreaCodeInput.tsx'
import { Input } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { problemText } from '../ui/LoadStates.tsx'
import { MarkGlyph } from '../ui/StatusMark.tsx'
import { runAdmin } from './api.ts'
import { errorText } from './notify.ts'

/** The round trip of a category's provider in use, if it has one (the realtime model, sign-in and storage have none). */
export const tryKindOf = (category: ProviderCategory): TryOutKind | null =>
  category === 'email' || category === 'llm' || category === 'stt' || category === 'tts' || category === 'telephony'
    ? category
    : null

const tryLabels: Record<TryOutKind, MessageKey> = {
  email: msg('admin.tryOut.label.email'),
  llm: msg('admin.tryOut.label.llm'),
  stt: msg('admin.tryOut.label.stt'),
  tts: msg('admin.tryOut.label.tts'),
  telephony: msg('admin.tryOut.label.telephony'),
}
const tryHelp: Record<TryOutKind, MessageKey> = {
  email: msg('admin.tryOut.help.email'),
  llm: msg('admin.tryOut.help.llm'),
  stt: msg('admin.tryOut.help.stt'),
  tts: msg('admin.tryOut.help.tts'),
  telephony: msg('admin.tryOut.help.telephony'),
}

/** Try it can run: the numbers lookup needs an area code from the list (the picker leaves it empty until then). */
export const canTry = (kind: TryOutKind, areaCode: string): boolean =>
  kind !== 'telephony' || !!buyableAreaCode(areaCode)

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
  const t = useT()
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
    <section className="adm-try" aria-label={t('admin.tryOut.title')}>
      <div className="adm-try-head">
        <div>
          <b>{t('admin.tryOut.title')}</b>
          <span className="help">{t(tryHelp[kind])}</span>
        </div>
        {/* Not a form: it sits inside the provider dialog's own form, so Enter here runs it, not Save. */}
        <div className="adm-try-form">
          {kind === 'telephony' && (
            // The searchable list of US area codes, as for a new number. Enter while the list is open picks a
            // code there; otherwise it runs Try it here.
            // biome-ignore lint/a11y/noStaticElementInteractions: only passes Enter on from the field inside
            <div className="adm-try-area" onKeyDown={e => onEnter(e, startTry)}>
              <AreaCodeInput
                id={areaId}
                // The countries its area codes are in (AREA_CODES), named in the reader's language.
                label={t('admin.tryOut.areaCodeIn', {
                  countries: i18n().format.list(
                    NUMBER_BUY_COUNTRIES.map(c => phoneCountryName(c, i18n())),
                    { type: 'disjunction' },
                  ),
                })}
                value={areaCode}
                onChange={setAreaCode}
              />
            </div>
          )}
          <Button
            variant={primary && !result?.ok ? 'primary' : 'secondary'}
            busy={busy && !result}
            disabled={busy || !canTry(kind, areaCode)}
            onClick={startTry}
          >
            {result ? t('common.action.tryAgain') : t(tryLabels[kind])}
          </Button>
        </div>
      </div>

      {result && (
        <div className={cx('adm-try-result', result.ok ? 'ok' : 'bad')} role="status">
          <span className="adm-try-mark" aria-hidden>
            <MarkGlyph kind={result.ok ? 'works' : 'partly'} size={12} />
          </span>
          <div className="adm-try-body">
            <span>{result.message}</span>
            {result.reply && (
              <blockquote className="adm-try-quote">
                <span className="help">{t('admin.tryOut.callerQuestion')}</span>
                {result.reply}
              </blockquote>
            )}
            {result.heard !== undefined && (
              <dl className="adm-try-heard">
                <dt>{t('admin.tryOut.said')}</dt>
                <dd>{result.expected}</dd>
                <dt>{t('admin.tryOut.heard')}</dt>
                <dd>{result.heard || t('admin.tryOut.nothingHeard')}</dd>
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
            aria-label={t('admin.tryOut.codeLabel')}
            placeholder={t('admin.tryOut.codePlaceholder')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={e => onEnter(e, startConfirm)}
            autoFocus
          />
          <Button variant="primary" busy={busy} disabled={busy || code.trim().length !== 6} onClick={startConfirm}>
            {t('admin.tryOut.confirm')}
          </Button>
        </div>
      )}
      {confirmed && (
        <div className="adm-try-result ok" role="status">
          <span className="adm-try-mark" aria-hidden>
            <MarkGlyph kind="works" size={12} />
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
