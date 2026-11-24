// The report a member writes from Help (LIN-639): a small form in place, next to the Help button (bottom left), so the
// page stays in view. One text box and the parts that may go with it (a screenshot of the page, the page, recent
// errors, version and browser), each with a checkbox and a "show" preview. ⌘↵ sends from anywhere in it, Esc closes.
import { useT } from '@linedesk/i18n/react'
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Backdrop } from '../ui/Backdrop.tsx'
import { Checkbox } from '../ui/controls.tsx'
import { FormField, Textarea } from '../ui/form.tsx'
import { Button, cx, Icon, Note } from '../ui/kit.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import {
  closeReport,
  type Included,
  MAX_TEXT,
  type OpenReport,
  REPORT_PARTS,
  type ReportKind,
  type ReportPart,
  reportInput,
  sendFeedback,
  settledReport,
  useOpenReport,
} from './report.ts'
import './feedback.css'

const SEND_KEYS = ['⌘', '↵']
const SENT_CLOSE_MS = 1600

/** What a member wrote and did not send yet, per kind: closing by accident loses nothing. */
const drafts: Record<ReportKind, string> = { bug: '', feature: '' }

/** The open report, if any (Workspace.tsx renders it once). */
export function ReportHost() {
  const report = useOpenReport()
  if (!report) return null
  return <ReportDialog key={report.key} report={report} onClose={closeReport} />
}

type Phase = 'edit' | 'sending' | 'sent'

type T = ReturnType<typeof useT>
const partLabel = (t: T, part: ReportPart): string =>
  part === 'screenshot'
    ? t('shell.feedback.part.screenshot')
    : part === 'page'
      ? t('shell.feedback.part.page')
      : part === 'errors'
        ? t('shell.feedback.part.errors')
        : t('shell.feedback.part.system')

/** The words of the report, by kind. */
const kindWords = (t: T, kind: ReportKind) =>
  kind === 'bug'
    ? {
        title: t('shell.feedback.bug.title'),
        question: t('shell.feedback.bug.question'),
        placeholder: t('shell.feedback.bug.placeholder'),
      }
    : {
        title: t('shell.feedback.feature.title'),
        question: t('shell.feedback.feature.question'),
        placeholder: t('shell.feedback.feature.placeholder'),
      }

/** Text, ticks, sending. */
function useReport(report: OpenReport, onClose: () => void) {
  const t = useT()
  const [text, setTextState] = useState(drafts[report.kind])
  const [include, setInclude] = useState<Included>({ screenshot: true, page: true, errors: true, system: true })
  const [phase, setPhase] = useState<Phase>('edit')
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [zoom, setZoom] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  // The large screenshot takes the focus while open and gives it back to the text when it closes, so ⌘↵ and Esc
  // keep reaching the report (the zoom button leaves the page, and focus would fall to the body).
  const zoomWasOpen = useRef(false)
  useEffect(() => {
    if (zoom) zoomWasOpen.current = true
    else if (zoomWasOpen.current) {
      zoomWasOpen.current = false
      textRef.current?.focus()
    }
  }, [zoom])
  const available = (part: ReportPart) =>
    part === 'screenshot' ? report.shot.state !== 'failed' : part === 'errors' ? !!report.errors : true
  const on = (part: ReportPart) => include[part] && available(part)
  const setText = (value: string) => {
    drafts[report.kind] = value
    setTextState(value)
    if (value.trim()) setMissing(false)
  }
  const toggle = (part: ReportPart, value = !include[part]) => setInclude(i => ({ ...i, [part]: value }))

  useEffect(() => {
    if (phase !== 'sent') return
    const id = setTimeout(onClose, SENT_CLOSE_MS)
    return () => clearTimeout(id)
  }, [phase, onClose])

  /** False when the text is missing (the field says so and takes the focus). */
  function checkText(): boolean {
    if (text.trim()) return true
    setMissing(true)
    textRef.current?.focus()
    return false
  }

  async function send() {
    if (phase !== 'edit' || !checkText()) return
    setPhase('sending')
    setError(null)
    try {
      const latest = include.screenshot ? ((await settledReport()) ?? report) : report
      const ticked = Object.fromEntries(REPORT_PARTS.map(p => [p, on(p)])) as Included
      await sendFeedback(reportInput(latest, text, ticked))
      drafts[report.kind] = ''
      setPhase('sent')
    } catch (e) {
      setPhase('edit')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** The report has the keyboard: ⌘↵ runs the main button, Esc closes (the large screenshot first); no app keys. */
  const onKeyDown = (primary: () => void) => (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      primary()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (zoom) setZoom(false)
      else onClose()
    }
    e.stopPropagation()
  }

  const kind = report.kind
  return {
    t,
    report,
    kind,
    ...kindWords(t, kind),
    text,
    setText,
    textRef,
    missing,
    include,
    on,
    available,
    toggle,
    phase,
    error,
    send,
    zoom,
    setZoom,
    onKeyDown,
    onClose,
  }
}
type Report = ReturnType<typeof useReport>

// ---- pieces every layout uses ----

function TextBox({ r, rows = 5 }: { r: Report; rows?: number }) {
  const id = useId()
  return (
    <FormField id={id} label={r.question} error={r.missing ? r.t('shell.feedback.textMissing') : null}>
      <Textarea
        id={id}
        ref={r.textRef}
        autoFocus
        rows={rows}
        maxLength={MAX_TEXT}
        invalid={r.missing}
        placeholder={r.placeholder}
        value={r.text}
        onChange={e => r.setText(e.target.value)}
        disabled={r.phase !== 'edit'}
      />
    </FormField>
  )
}

/** The screenshot: a skeleton while it is taken; a click shows it large. */
function Shot({ r }: { r: Report }) {
  const shot = r.report.shot
  if (shot.state === 'failed') return null
  if (shot.state === 'taking')
    return (
      <span className="fb-shot ld-busy" aria-busy="true">
        <Skeleton shape="block" />
        <span className="sr-only">{r.t('shell.feedback.shot.taking')}</span>
      </span>
    )
  return (
    <button
      type="button"
      className="fb-shot"
      title={r.t('shell.feedback.shot.open')}
      aria-label={r.t('shell.feedback.shot.open')}
      onClick={() => r.setZoom(true)}
    >
      <img src={shot.url} alt={r.t('shell.feedback.shot.alt')} />
    </button>
  )
}

/** What a part sends, in full: the screenshot, or the text. */
function PartContent({ r, part }: { r: Report; part: ReportPart }) {
  if (part === 'screenshot')
    return r.report.shot.state === 'failed' ? (
      <p className="fb-muted">{r.t('shell.feedback.shot.failed')}</p>
    ) : (
      <Shot r={r} />
    )
  const text = part === 'page' ? r.report.page : part === 'errors' ? r.report.errors : r.report.system
  return text ? <pre className="fb-pre">{text}</pre> : <p className="fb-muted">{r.t('shell.feedback.errors.none')}</p>
}

function PartCheck({ r, part, children }: { r: Report; part: ReportPart; children?: ReactNode }) {
  return (
    <Checkbox
      checked={r.on(part)}
      disabled={!r.available(part) || r.phase !== 'edit'}
      onChange={value => r.toggle(part, value)}
      label={children ? undefined : partLabel(r.t, part)}
    >
      {children}
    </Checkbox>
  )
}

function Zoom({ r }: { r: Report }) {
  if (!r.zoom || r.report.shot.state !== 'ready') return null
  return (
    <button
      type="button"
      className="fb-zoom"
      autoFocus
      aria-label={r.t('shell.feedback.closeZoom')}
      title={r.t('shell.feedback.closeZoom')}
      onClick={() => r.setZoom(false)}
    >
      <img src={r.report.shot.url} alt={r.t('shell.feedback.shot.alt')} />
    </button>
  )
}

function SendButton({ r, label, onClick }: { r: Report; label?: string; onClick?: () => void }) {
  return (
    <Button
      variant="primary"
      icon="send"
      busy={r.phase === 'sending'}
      shortcut={SEND_KEYS}
      title={r.t('shell.feedback.sendTip', { key: '⌘↵' })}
      onClick={onClick ?? (() => void r.send())}
    >
      {label ?? r.t('shell.feedback.send')}
    </Button>
  )
}

function Failure({ r }: { r: Report }) {
  return r.error ? <Note tone="danger">{r.t('shell.feedback.failed', { reason: r.error })}</Note> : null
}

function Sent({ r }: { r: Report }) {
  return (
    <div className="fb-sent" role="status">
      <span className="fb-sent-mark">
        <Icon name="check" size={20} />
      </span>
      <b>{r.t('shell.feedback.sent')}</b>
    </div>
  )
}

/** The form box with the keyboard, in a clear layer (the page stays visible). */
function Frame({ r, style, children }: { r: Report; style: CSSProperties; children: ReactNode }) {
  return (
    <Backdrop onClose={r.onClose} anchored>
      <div
        className={cx('k-dialog fb-report', r.phase === 'sent' && 'is-sent')}
        role="dialog"
        aria-modal="true"
        aria-label={r.title}
        tabIndex={-1}
        data-no-shot
        style={style}
        onKeyDown={r.onKeyDown(() => void r.send())}
      >
        {children}
        <Zoom r={r} />
      </div>
    </Backdrop>
  )
}

/** Next to the Help button when it stays on screen (the docked navigation), else at the bottom left, where it was. */
function popoverPlace(): CSSProperties {
  // Only while the navigation is docked: the slide-in one closes when a report opens.
  const help = document.querySelector('.app.nav-docked .help-btn')?.getBoundingClientRect()
  const width = Math.min(380, window.innerWidth - 16)
  if (help && help.width > 0 && help.right > 0) {
    const left = Math.min(help.right + 8, window.innerWidth - width - 8)
    return { position: 'fixed', left, bottom: Math.max(8, window.innerHeight - help.bottom), width }
  }
  return { position: 'fixed', left: 12, bottom: 12, width }
}

function Popover({ r }: { r: Report }) {
  const [shown, setShown] = useState<ReportPart | null>(null)
  const [place] = useState(popoverPlace)
  return (
    <Frame r={r} style={place}>
      <header className="fb-pop-head">
        <Icon name={r.kind === 'bug' ? 'bug' : 'bulb'} size={15} />
        <b>{r.title}</b>
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          aria-label={r.t('common.action.close')}
          title={r.t('common.action.closeWithKey', { key: 'esc' })}
          onClick={r.onClose}
        />
      </header>
      {r.phase === 'sent' ? (
        <Sent r={r} />
      ) : (
        <>
          <div className="fb-pop-body">
            <TextBox r={r} rows={4} />
            <div className="fb-inline-parts" role="group" aria-label={r.t('shell.feedback.attachTitle')}>
              {REPORT_PARTS.map(part => (
                <span key={part} className={cx('fb-inline-part', !r.on(part) && 'is-off')}>
                  <PartCheck r={r} part={part}>
                    {partLabel(r.t, part)}
                  </PartCheck>
                  {r.available(part) && (
                    <button
                      type="button"
                      className="fb-link"
                      aria-expanded={shown === part}
                      onClick={() => setShown(shown === part ? null : part)}
                    >
                      {shown === part ? r.t('shell.feedback.hide') : r.t('shell.feedback.show')}
                    </button>
                  )}
                </span>
              ))}
            </div>
            {shown && (
              <div className="fb-pop-preview">
                <PartContent r={r} part={shown} />
              </div>
            )}
            {/* Where it goes: FEEDBACK_EMAIL (apps/api/src/feedback.ts), which the app does not know. */}
            <p className="fb-muted">{r.t('shell.feedback.destination')}</p>
            <Failure r={r} />
          </div>
          <footer className="fb-pop-foot">
            <SendButton r={r} />
          </footer>
        </>
      )}
    </Frame>
  )
}

export function ReportDialog({ report, onClose }: { report: OpenReport; onClose: () => void }) {
  return <Popover r={useReport(report, onClose)} />
}
