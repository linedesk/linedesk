// Settings › Assistant › Business info (LIN-724): About the business as two parts, the business's own text and the
// questions and answers (aboutModel.ts), with Try a question, a health check and an editor in a side panel. The
// assistant still reads one text (draft.instructions, saved with Save); Write with help (WriteWithHelp.tsx) drafts it.
// Questions callers asked that it could not answer are answered in Open questions (review/AssistantReview.tsx).
import { INSTRUCTIONS_MAX, type KnowledgeImproveData } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fmt } from '../i18n/format.ts'
import { Input, Textarea } from '../ui/form.tsx'
import { Badge, Button, cx, Icon } from '../ui/kit.tsx'
import {
  type AboutIssue,
  type AboutParts,
  type AboutQuestion,
  answeredFrom,
  checkAbout,
  draftKey,
  joinAbout,
  keyAfter,
  newQuestion,
  parseAbout,
  written,
} from './aboutModel.ts'
import type { Draft } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'
import { hasKnowledge } from './knowledgeModel.ts'
import { callAction } from './settings-api.ts'
import { WriteWithHelp } from './WriteWithHelp.tsx'
import './knowledge.css'

type Props = {
  assistant: Assistant
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  replace: (next: Draft) => void
  canEdit: boolean
  toast: (text: string) => void
}

type Filter = 'all' | 'mail' | 'answered' | 'check'

const count = (n: number) => fmt().number(n)
/** The length shows only from this share of the limit on: below it, the number says nothing worth reading. */
const COUNT_FROM = 0.8
// i18n-dynamic: settings.knowledge.issue.*
// i18n-dynamic: settings.knowledge.qa.source.*
const issuesOf = (issues: AboutIssue[], key: string) => issues.filter(i => i.key === key)

export function Knowledge(props: Props) {
  const t = useT()
  const { draft, set, canEdit } = props
  const empty = !hasKnowledge(draft)
  const name = draft.name.trim() || t('settings.knowledge.theAssistant')
  const [helping, setHelping] = useState(false)
  const parts = useMemo(() => parseAbout(draft.instructions), [draft.instructions])
  // Rows added on the page that have no text yet: not in the About text until they have a question and an answer.
  const [drafts, setDrafts] = useState<AboutQuestion[]>([])
  const all: AboutParts = { ...parts, questions: [...parts.questions, ...drafts] }
  const update = (next: AboutParts) => {
    set('instructions', joinAbout(next))
    setDrafts(next.questions.filter(q => !written(q)).map(q => ({ ...q, key: draftKey(q.key) })))
  }
  return (
    <Section
      id="as-instructions"
      title={t('settings.knowledge.title')}
      description={empty ? t('settings.knowledge.emptyDescription') : t('settings.knowledge.description')}
      actions={
        <Button
          size="sm"
          variant={empty ? 'primary' : 'secondary'}
          icon="spark"
          disabled={!canEdit}
          onClick={() => setHelping(true)}
          title={t('settings.knowledge.writeWithHelpTip')}
        >
          {t('settings.knowledge.writeWithHelp')}
        </Button>
      }
      help={t('settings.knowledge.help', { name })}
    >
      <BusinessText parts={all} update={update} name={name} canEdit={canEdit} />
      <Questions {...props} parts={all} update={update} name={name} addDraft={q => setDrafts(d => [...d, q])} />
      {draft.instructions.trim().length >= INSTRUCTIONS_MAX * COUNT_FROM && (
        <span className="help kn-total">
          {t('settings.knowledge.length', {
            count: count(draft.instructions.trim().length),
            max: count(INSTRUCTIONS_MAX),
          })}
        </span>
      )}
      {helping && <WriteWithHelp {...props} onClose={() => setHelping(false)} />}
    </Section>
  )
}

// --- Your business ------------------------------------------------------------------------

/** The business's own text, shown to read (labels bold, lists as bullets); Edit opens it as a text field. */
function BusinessText(props: { parts: AboutParts; update: (p: AboutParts) => void; name: string; canEdit: boolean }) {
  const { parts, update, name, canEdit } = props
  const t = useT()
  const [editing, setEditing] = useState(false)
  const open = editing || !parts.profile.trim()
  // The same line can come twice: the key is its place and its text.
  const rows = parts.profile
    .split('\n')
    .filter(l => l.trim())
    .map((line, n) => ({ line, id: `${n}:${line}` }))
  return (
    <div className="kn-block">
      <div className="kn-block-head">
        <b>{t('settings.knowledge.business.title')}</b>
        {parts.profile.trim() && (
          <Button
            size="sm"
            variant="secondary"
            icon={editing ? 'check' : 'pencil'}
            disabled={!canEdit}
            onClick={() => setEditing(!editing)}
            title={t('settings.knowledge.business.editTip')}
          >
            {editing ? t('settings.knowledge.business.done') : t('settings.knowledge.business.edit')}
          </Button>
        )}
      </div>
      {open ? (
        <Field id="as-instr" label={t('settings.knowledge.label', { name })}>
          <TextArea
            id="as-instr"
            tall
            value={parts.profile}
            onChange={v => update({ ...parts, profile: v })}
            placeholder={t('settings.knowledge.placeholder')}
          />
        </Field>
      ) : (
        <div className="kn-read">
          {rows.map(({ line, id }) => {
            const label = /^([^:\n]{2,40}:)\s*(.*)$/.exec(line)
            if (/^\s*[-•]\s/.test(line))
              return (
                <div key={id} className="kn-bullet">
                  {line.replace(/^\s*[-•]\s/, '')}
                </div>
              )
            if (label && !label[2]) return <b key={id}>{label[1]}</b>
            if (label)
              return (
                <div key={id}>
                  <b>{label[1]}</b> {label[2]}
                </div>
              )
            return <p key={id}>{line}</p>
          })}
        </div>
      )}
    </div>
  )
}

// --- Questions and answers -----------------------------------------------------------------

type QuestionsProps = Props & {
  parts: AboutParts
  update: (p: AboutParts) => void
  name: string
  addDraft: (q: AboutQuestion) => void
}

/** What a help step replaced, to undo it: the rows as they were and the row that was open. */
type Undo = { parts: AboutParts; key: string }

function Questions(props: QuestionsProps) {
  const { parts, name, canEdit } = props
  const t = useT()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpenRaw] = useState<string | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const setOpen = (key: string | null) => {
    setUndo(null)
    setOpenRaw(key)
  }
  // The open row stays open when the text is written and read back (keyAfter).
  const update = (next: AboutParts) => {
    props.update(next)
    setOpenRaw(key => (key ? keyAfter(next, key) : key))
  }
  const added = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const issues = useMemo(() => checkAbout(parts), [parts])
  const flagged = new Set(issues.map(i => i.key))
  const filled = parts.questions.filter(q => q.line || q.question.trim())
  const shown = parts.questions.filter(q => {
    if ((filter === 'mail' || filter === 'answered') && q.source !== filter) return false
    if (filter === 'check' && !flagged.has(q.key)) return false
    const s = search.trim().toLowerCase()
    return !s || `${q.question} ${q.answer}`.toLowerCase().includes(s)
  })
  const current = parts.questions.find(q => q.key === open) ?? null

  // "/" searches the questions (not while typing somewhere).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      if (e.key !== '/' || e.metaKey || e.ctrlKey || el?.closest('input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setQuestion = (key: string, change: Partial<AboutQuestion>) =>
    update({ ...parts, questions: parts.questions.map(q => (q.key === key ? { ...q, ...change } : q)) })
  const remove = (key: string) => {
    update({ ...parts, questions: parts.questions.filter(q => q.key !== key) })
    setOpen(null)
  }
  const add = (question = '') => {
    const q = { ...newQuestion(++added.current), question }
    props.addDraft(q)
    setOpen(q.key)
  }

  const chips: [Filter, string, number][] = [
    ['all', t('settings.knowledge.qa.filter.all'), filled.length],
    ['mail', t('settings.knowledge.qa.filter.mail'), filled.filter(q => q.source === 'mail').length],
    ['answered', t('settings.knowledge.qa.filter.answered'), filled.filter(q => q.source === 'answered').length],
    ['check', t('settings.knowledge.qa.filter.check'), flagged.size],
  ]

  return (
    <div className="kn-block kn-qa">
      <div className="kn-block-head">
        <b>{t('settings.knowledge.qa.title')}</b>
        {filled.length > 0 && (
          <span className="kn-sub">{t('settings.knowledge.qa.count', { count: filled.length, name })}</span>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          disabled={!canEdit}
          onClick={() => add()}
          title={t('settings.knowledge.qa.addTip')}
        >
          {t('settings.knowledge.qa.add')}
        </Button>
      </div>
      <TryQuestion {...props} onOpen={setOpen} onAdd={add} />
      {filled.length > 0 && (
        <div className="kn-toolbar">
          <Input
            ref={searchRef}
            size="sm"
            className="kn-search"
            start={<Icon name="search" size={14} />}
            placeholder={t('settings.knowledge.qa.search')}
            title={t('settings.knowledge.qa.searchTip')}
            aria-label={t('settings.knowledge.qa.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="kn-chips" role="group">
            {chips.map(([f, label, n]) =>
              f === 'check' && !n ? null : (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  className={cx('kn-chip', filter === f && 'is-on', f === 'check' && 'is-warn')}
                  onClick={() => setFilter(f)}
                >
                  {label} <span>{count(n)}</span>
                </button>
              ),
            )}
          </div>
        </div>
      )}
      {parts.questions.length === 0 ? (
        <p className="kn-sub kn-empty">{t('settings.knowledge.qa.empty')}</p>
      ) : shown.length === 0 ? (
        <p className="kn-sub kn-empty">{t('settings.knowledge.qa.noMatch')}</p>
      ) : (
        <div className="kn-qlist">
          {shown.map(q => (
            <QuestionRow
              key={q.key}
              q={q}
              issues={issuesOf(issues, q.key)}
              active={q.key === open}
              onClick={() => setOpen(q.key === open ? null : q.key)}
            />
          ))}
        </div>
      )}
      {current && (
        <QuestionPanel
          {...props}
          update={update}
          undo={undo}
          onHelped={setUndo}
          onUndo={() => {
            if (!undo) return
            props.update(undo.parts)
            setOpenRaw(undo.key)
            setUndo(null)
          }}
          q={current}
          issues={issuesOf(issues, current.key)}
          onChange={change => setQuestion(current.key, change)}
          onRemove={() => remove(current.key)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function QuestionRow(props: { q: AboutQuestion; issues: AboutIssue[]; active: boolean; onClick: () => void }) {
  const { q, issues, active, onClick } = props
  const t = useT()
  return (
    <button type="button" className={cx('kn-qrow', active && 'is-at')} onClick={onClick} aria-expanded={active}>
      <span className="kn-qrow-main">
        <b className={cx(!q.question.trim() && 'kn-untitled')}>
          {q.question.trim() || t('settings.knowledge.qa.untitled')}
        </b>
        {q.answer && <span className="kn-qrow-answer">{q.answer}</span>}
        {issues.length > 0 && (
          <span className="kn-qrow-tags">
            {issues.map(i => (
              <Badge key={i.kind} tone="warning" dot>
                {t(`settings.knowledge.issue.${i.kind}`)}
              </Badge>
            ))}
          </span>
        )}
      </span>
      <span className="kn-qrow-src" title={t(`settings.knowledge.qa.source.${q.source}`)}>
        <Icon name={q.source === 'mail' ? 'mail' : 'pencil'} size={14} />
      </span>
    </button>
  )
}

// --- Side panel ------------------------------------------------------------------------------

type PanelProps = QuestionsProps & {
  q: AboutQuestion
  issues: AboutIssue[]
  onChange: (change: Partial<AboutQuestion>) => void
  onRemove: () => void
  onClose: () => void
  undo: Undo | null
  onHelped: (undo: Undo) => void
  onUndo: () => void
}

/** One question and its answer, beside the list (the list stays usable; another row opens in its place). */
function QuestionPanel(props: PanelProps) {
  const { q, issues, onChange, onRemove, onClose, name, canEdit, parts, update, undo } = props
  const t = useT()
  const first = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<AboutIssue['kind'] | null>(null)

  // On a wide screen the page makes room for the panel, so the list and the Save bar stay in view.
  useEffect(() => {
    document.body.classList.add('kn-panel-open')
    return () => document.body.classList.remove('kn-panel-open')
  }, [])
  // A new row starts in its question field.
  useEffect(() => {
    if (!q.line) first.current?.focus()
  }, [q.line])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function improve(issue: AboutIssue) {
    const other = issue.kind === 'duplicate' ? parts.questions.find(x => x.key === issue.other) : undefined
    setBusy(issue.kind)
    try {
      const items = [other, q]
        .filter((x): x is AboutQuestion => !!x)
        .map(x => ({ question: x.question, answer: x.answer }))
      const data = await callAction<KnowledgeImproveData>('knowledge.improve', {
        assistantId: props.assistant.id,
        kind: issue.kind === 'duplicate' ? 'merge' : issue.kind === 'long' ? 'shorten' : 'translate',
        items,
        ...(issue.kind === 'language' ? { language: issue.language } : {}),
      })
      props.onHelped({ parts, key: q.key })
      update({
        ...parts,
        questions: parts.questions
          .filter(x => x.key !== other?.key)
          .map(x => (x.key === q.key ? { ...x, ...data } : x)),
      })
    } catch (e) {
      props.toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const otherOf = (i: AboutIssue) =>
    i.kind === 'duplicate' ? (parts.questions.find(x => x.key === i.other)?.question ?? '') : ''
  const panel = (
    <aside className="kn-panel" aria-label={t('settings.knowledge.panel.title')}>
      <div className="kn-panel-head">
        <b>{q.line ? t('settings.knowledge.panel.title') : t('settings.knowledge.panel.new')}</b>
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          onClick={onClose}
          aria-label={t('settings.knowledge.panel.close')}
          title={t('settings.knowledge.panel.closeTip')}
        />
      </div>
      {undo && (
        <div className="kn-helped">
          <Icon name="spark" size={14} />
          <span>{t('settings.knowledge.issue.helped')}</span>
          <Button size="sm" variant="ghost" onClick={props.onUndo}>
            {t('settings.knowledge.issue.undo')}
          </Button>
        </div>
      )}
      {!undo &&
        issues.map(i => (
          <div key={i.kind} className="kn-issue">
            <Icon name="warning" size={14} />
            <span>{t(`settings.knowledge.issue.${i.kind}Text`, { other: otherOf(i) })}</span>
            <Button
              size="sm"
              variant="ghost"
              icon="spark"
              busy={busy === i.kind}
              disabled={!canEdit || (busy !== null && busy !== i.kind)}
              onClick={() => improve(i)}
              title={t('settings.knowledge.issue.helpTip')}
            >
              {t(`settings.knowledge.issue.${i.kind}Do`)}
            </Button>
          </div>
        ))}
      <div className="kn-pfield">
        <label htmlFor="kn-question">{t('settings.knowledge.panel.question')}</label>
        <Input
          id="kn-question"
          ref={first}
          value={q.question}
          disabled={!canEdit}
          onChange={e => onChange({ question: e.target.value.replace(/"/g, '“') })}
        />
      </div>
      <div className="kn-pfield">
        <label htmlFor="kn-answer">{t('settings.knowledge.panel.answer')}</label>
        <span className="kn-sub">{t('settings.knowledge.panel.answerHelp', { name })}</span>
        <Textarea
          id="kn-answer"
          rows={8}
          value={q.answer}
          disabled={!canEdit}
          onChange={e => onChange({ answer: e.target.value })}
        />
        <span className="kn-sub kn-chars">{t('settings.knowledge.panel.chars', { count: q.answer.length })}</span>
      </div>
      <div className="kn-panel-foot">
        <span className="kn-sub">
          <Icon name={q.source === 'mail' ? 'mail' : 'pencil'} size={13} />{' '}
          {t(`settings.knowledge.qa.source.${q.source}`)}
        </span>
        <Button size="sm" variant="ghost" icon="trash" disabled={!canEdit} onClick={onRemove}>
          {t('settings.knowledge.panel.delete')}
        </Button>
      </div>
      <p className="kn-sub">{t('settings.knowledge.panel.saveNote')}</p>
    </aside>
  )
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body)
}

// --- Try a question --------------------------------------------------------------------------

/** What the assistant answers a caller's question, with the text as it is now (saved or not), and the row it used. */
function TryQuestion(props: QuestionsProps & { onOpen: (key: string) => void; onAdd: (question: string) => void }) {
  const { parts, name, canEdit, draft } = props
  const t = useT()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ question: string; answer: string } | null>(null)
  const from = result ? answeredFrom(parts, result.question, result.answer) : null

  async function ask() {
    const question = text.trim()
    if (!question) return
    setBusy(true)
    try {
      const data = await callAction<{ answer: string }>('knowledge.try', {
        assistantId: props.assistant.id,
        question,
        instructions: draft.instructions,
      })
      setResult({ question, answer: data.answer })
    } catch (e) {
      props.toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kn-try">
      <form
        className="kn-try-row"
        onSubmit={e => {
          e.preventDefault()
          e.stopPropagation()
          void ask()
        }}
      >
        <Icon name="message" size={15} />
        <input
          placeholder={t('settings.knowledge.try.placeholder')}
          aria-label={t('settings.knowledge.try.placeholder')}
          value={text}
          maxLength={300}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void ask()
            }
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          disabled={!canEdit || !text.trim()}
          onClick={() => void ask()}
          title={t('settings.knowledge.try.tip', { name })}
        >
          {t('settings.knowledge.try.ask', { name })}
        </Button>
      </form>
      {result && (
        <div className="kn-try-answer">
          <p>
            <b>{name}:</b> {result.answer}
          </p>
          {from ? (
            <button type="button" className="kn-try-from" onClick={() => props.onOpen(from.key)}>
              {t('settings.knowledge.try.from', { question: from.question })}
            </button>
          ) : (
            <button
              type="button"
              className="kn-try-from"
              disabled={!canEdit}
              onClick={() => props.onAdd(result.question)}
            >
              {t('settings.knowledge.try.addAsQuestion')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
