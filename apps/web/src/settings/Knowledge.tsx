// Settings › Assistant › Business info (LIN-724): About the business as two parts, the business's own text and the
// questions and answers (aboutModel.ts), with Try a question, a health check and an editor in a side panel. The
// assistant still reads one text (draft.instructions, saved with Save); Write with help (WriteWithHelp.tsx) drafts it.
// Questions callers asked that it could not answer are answered in Open questions (review/AssistantReview.tsx).
import { INSTRUCTIONS_MAX, type KnowledgeImproveData } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useMemo, useRef, useState } from 'react'
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

const count = (n: number) => fmt().number(n)
/** The length shows only from this share of the limit on: below it, the number says nothing worth reading. */
const COUNT_FROM = 0.8
// i18n-dynamic: settings.knowledge.issue.*
/** Search shows only from this many questions on; fewer fit on the screen. */
const SEARCH_FROM = 6
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
      <BusinessText parts={all} update={update} name={name} />
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

// --- What the assistant should know ---------------------------------------------------------

/** The business's own text (everything but the question lines), always a text field. */
function BusinessText(props: { parts: AboutParts; update: (p: AboutParts) => void; name: string }) {
  const { parts, update, name } = props
  const t = useT()
  return (
    <Field id="as-instr" label={t('settings.knowledge.label', { name })}>
      <TextArea
        id="as-instr"
        tall
        value={parts.profile}
        onChange={v => update({ ...parts, profile: v })}
        placeholder={t('settings.knowledge.placeholder')}
      />
    </Field>
  )
}

// --- Questions and answers -----------------------------------------------------------------

type QuestionsProps = Props & {
  parts: AboutParts
  update: (p: AboutParts) => void
  name: string
  addDraft: (q: AboutQuestion) => void
}

function Questions(props: QuestionsProps) {
  const { parts, name, canEdit } = props
  const t = useT()
  const [search, setSearch] = useState('')
  const [onlyCheck, setOnlyCheck] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  // The open row stays open when the text is written and read back (keyAfter).
  const update = (next: AboutParts) => {
    props.update(next)
    setOpen(key => (key ? keyAfter(next, key) : key))
  }
  const added = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const issues = useMemo(() => checkAbout(parts), [parts])
  const flagged = new Set(issues.map(i => i.key))
  const filled = parts.questions.filter(q => q.line || q.question.trim())
  const shown = parts.questions.filter(q => {
    if (onlyCheck && !flagged.has(q.key)) return false
    const s = search.trim().toLowerCase()
    return !s || `${q.question} ${q.answer}`.toLowerCase().includes(s)
  })

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

  const [trying, setTrying] = useState(false)

  return (
    <div className="kn-block kn-qa">
      <div className="kn-block-head">
        <b>{t('settings.knowledge.qa.title')}</b>
        <Button
          size="sm"
          variant="ghost"
          icon="message"
          className="kn-head-first"
          aria-pressed={trying}
          disabled={!canEdit}
          onClick={() => setTrying(!trying)}
          title={t('settings.knowledge.try.tip', { name })}
        >
          {t('settings.knowledge.try.open')}
        </Button>
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
      {trying && <TryQuestion {...props} onOpen={setOpen} onAdd={add} onClose={() => setTrying(false)} />}
      {(filled.length > SEARCH_FROM || flagged.size > 0) && (
        <div className="kn-toolbar">
          {filled.length > SEARCH_FROM && (
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
          )}
          {flagged.size > 0 && (
            <button
              type="button"
              aria-pressed={onlyCheck}
              className={cx('kn-chip is-warn', onlyCheck && 'is-on')}
              onClick={() => setOnlyCheck(!onlyCheck)}
            >
              {t('settings.knowledge.qa.filter.check')} <span>{count(flagged.size)}</span>
            </button>
          )}
        </div>
      )}
      {parts.questions.length === 0 ? (
        <p className="kn-sub kn-empty">{t('settings.knowledge.qa.empty')}</p>
      ) : shown.length === 0 ? (
        <p className="kn-sub kn-empty">{t('settings.knowledge.qa.noMatch')}</p>
      ) : (
        <div className="kn-qlist">
          {shown.map(q =>
            q.key === open ? (
              <QuestionEditor
                key={q.key}
                {...props}
                update={update}
                q={q}
                issues={issuesOf(issues, q.key)}
                onChange={change => setQuestion(q.key, change)}
                onRemove={() => remove(q.key)}
                onClose={() => setOpen(null)}
              />
            ) : (
              <QuestionRow key={q.key} q={q} issues={issuesOf(issues, q.key)} onClick={() => setOpen(q.key)} />
            ),
          )}
        </div>
      )}
    </div>
  )
}

function QuestionRow(props: { q: AboutQuestion; issues: AboutIssue[]; onClick: () => void }) {
  const { q, issues, onClick } = props
  const t = useT()
  return (
    <button
      type="button"
      className="kn-qrow"
      onClick={onClick}
      aria-expanded={false}
      title={t('settings.knowledge.qa.editTip')}
    >
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
    </button>
  )
}

// --- Editing a row in place ------------------------------------------------------------------

type EditorProps = QuestionsProps & {
  q: AboutQuestion
  issues: AboutIssue[]
  onChange: (change: Partial<AboutQuestion>) => void
  onRemove: () => void
  onClose: () => void
}

/** One question and its answer, edited where its row is (one row open at a time; Esc or Done closes it). */
function QuestionEditor(props: EditorProps) {
  const { q, issues, onChange, onRemove, onClose, canEdit, parts, update } = props
  const t = useT()
  const first = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<AboutIssue['kind'] | null>(null)

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
  return (
    <div className="kn-qedit" role="group" aria-label={t('settings.knowledge.panel.title')}>
      {issues.map(i => (
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
        <Textarea
          id="kn-answer"
          rows={4}
          value={q.answer}
          disabled={!canEdit}
          onChange={e => onChange({ answer: e.target.value })}
        />
      </div>
      <div className="kn-qedit-foot">
        <Button size="sm" variant="ghost" icon="trash" disabled={!canEdit} onClick={onRemove}>
          {t('settings.knowledge.panel.delete')}
        </Button>
        <Button size="sm" variant="primary" onClick={onClose} title={t('settings.knowledge.panel.closeTip')}>
          {t('settings.knowledge.panel.done')}
        </Button>
      </div>
    </div>
  )
}

// --- Try a question --------------------------------------------------------------------------

/** What the assistant answers a caller's question, with the text as it is now (saved or not), and the row it used. */
function TryQuestion(
  props: QuestionsProps & { onOpen: (key: string) => void; onAdd: (question: string) => void; onClose: () => void },
) {
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
      {/* Not a form: the settings page is one (a nested form is invalid); Enter asks through onKeyDown. */}
      <div className="kn-try-row">
        <input
          autoFocus
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
            if (e.key === 'Escape') props.onClose()
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
      </div>
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
