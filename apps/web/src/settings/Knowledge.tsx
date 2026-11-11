// Settings › Assistant › Knowledge: what the assistant knows about the business: questions callers asked
// that it could not answer, About the business (with Write with help, WriteWithHelp.tsx), services and
// prices, FAQs and documents. About, services and FAQs are part of
// the assistant's draft (saved with Save); documents and answered questions are saved at once.
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENTS_MAX,
  type documentTypes,
  FAQS_MAX,
  INSTRUCTIONS_MAX,
  PRICE_MAX,
  SERVICES_MAX,
} from '@linedesk/actions'
import type { Assistant, KnowledgeDocument, KnowledgeQuestion } from '@linedesk/db/types'
import { useRef, useState } from 'react'
import { useRows } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import type { Draft } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'
import { documentsUse, fileSize, hasKnowledge } from './knowledgeModel.ts'
import { useWriteAction } from './settings-api.ts'
import { fileToBase64 } from './voiceModel.ts'
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

const count = (n: number) => n.toLocaleString('en-US')

export function Knowledge(props: Props) {
  const { assistant, draft } = props
  const documents = useRows('knowledge_documents')
    .filter(d => d.assistant_id === assistant.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const questions = useRows('knowledge_questions')
    .filter(q => q.assistant_id === assistant.id && q.status === 'open')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const empty = !hasKnowledge(draft, documents.length)
  const name = draft.name.trim() || 'The assistant'

  return (
    <>
      {questions.length > 0 && <QuestionsCard {...props} questions={questions} name={name} />}
      <AboutCard {...props} name={name} empty={empty} />
      <ServicesCard {...props} name={name} />
      <FaqsCard {...props} />
      <DocumentsCard {...props} documents={documents} name={name} />
    </>
  )
}

// --- Questions the assistant could not answer ----------------------------------------------

function QuestionsCard({
  draft,
  set,
  toast,
  questions,
  name,
}: Props & { questions: KnowledgeQuestion[]; name: string }) {
  return (
    <Section
      id="kn-questions"
      title={`Questions ${name} couldn't answer`}
      description="Answer once; it becomes an FAQ for every caller."
    >
      <ul className="kn-list">
        {questions.map(q => (
          <QuestionRow
            key={q.id}
            question={q}
            toast={toast}
            onAnswered={faq => {
              // Unsaved FAQ edits keep the new one too; untouched FAQs follow the saved assistant.
              set('faqs', [...draft.faqs, faq])
            }}
          />
        ))}
      </ul>
    </Section>
  )
}

function QuestionRow({
  question,
  toast,
  onAnswered,
}: {
  question: KnowledgeQuestion
  toast: (t: string) => void
  onAnswered: (faq: { q: string; a: string }) => void
}) {
  const write = useWriteAction()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  async function run(action: 'knowledgeQuestion.answer' | 'knowledgeQuestion.dismiss') {
    setBusy(true)
    try {
      await write(
        action,
        action === 'knowledgeQuestion.answer'
          ? { questionId: question.id, answer: answer.trim() }
          : { questionId: question.id },
      )
      if (action === 'knowledgeQuestion.answer') {
        onAnswered({ q: question.question, a: answer.trim() })
        toast('Added to the FAQs.')
      }
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <li className="kn-row kn-question">
      <div className="kn-main">
        <b>{question.question}</b>
        {question.call_id && (
          <a className="kn-sub" href={`#call/${question.call_id}`}>
            From a call on{' '}
            {new Date(question.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </a>
        )}
        <Input
          value={answer}
          placeholder="Your answer"
          aria-label={`Answer to: ${question.question}`}
          disabled={busy}
          onChange={e => setAnswer(e.target.value)}
        />
      </div>
      <div className="kn-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !answer.trim()}
          onClick={() => void run('knowledgeQuestion.answer')}
          title="Save the answer as an FAQ"
        >
          Add to FAQs
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run('knowledgeQuestion.dismiss')}
          title="Not worth an answer"
        >
          Dismiss
        </Button>
      </div>
    </li>
  )
}

// --- About, services, FAQs -----------------------------------------------------------------

function AboutCard(props: Props & { name: string; empty: boolean }) {
  const { draft, set, name, empty, canEdit } = props
  const [helping, setHelping] = useState(false)
  return (
    <Section
      id="as-instructions"
      title="About the business"
      description={
        empty
          ? 'Not sure where to start? Write with help asks a few questions and drafts it for you.'
          : 'Write it like you would brief a new hire.'
      }
      actions={
        <Button
          size="sm"
          variant={empty ? 'primary' : 'secondary'}
          icon="spark"
          disabled={!canEdit}
          onClick={() => setHelping(true)}
          title="Answer a few questions and get a draft to review"
        >
          Write with help
        </Button>
      }
      help={`What ${name} should know and how to answer: what you do, the area you cover, how you handle prices, what to ask callers. Opening hours and holidays go under Hours & holidays; ${name} reads them from there.`}
    >
      <Field id="as-instr" label={`What ${name} should know`}>
        <TextArea
          id="as-instr"
          tall
          value={draft.instructions}
          onChange={v => set('instructions', v)}
          placeholder={
            'We are a family-run plumbing company in Portland.\nWe cover Portland, Beaverton and Lake Oswego.\nWe give free estimates on site.'
          }
        />
        <span className="help">
          {count(draft.instructions.trim().length)} / {count(INSTRUCTIONS_MAX)}
        </span>
      </Field>
      {helping && <WriteWithHelp {...props} onClose={() => setHelping(false)} />}
    </Section>
  )
}

/** Which row of a list is open for editing; a new row opens itself, a row missing what it needs stays open. */
function useOpenRow() {
  const [open, setOpen] = useState<number | null>(null)
  return { open, setOpen, toggle: (i: number) => setOpen(o => (o === i ? null : i)) }
}

/** Edit and Remove at the end of a compact row. */
function RowActions({ what, open, canEdit, onEdit, onRemove }: { what: string; open: boolean; canEdit: boolean; onEdit: () => void; onRemove: () => void }) {
  if (!canEdit) return null
  return (
    <>
      <Button size="sm" variant="ghost" icon="pencil" aria-label={`Edit ${what}`} title={open ? 'Close' : 'Edit'} onClick={onEdit} aria-expanded={open} />
      <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${what}`} title="Remove" onClick={onRemove} />
    </>
  )
}

function ServicesCard({ draft, set, canEdit, name }: Props & { name: string }) {
  const services = draft.services
  const rows = useOpenRow()
  const update = (i: number, change: Partial<Draft['services'][number]>) =>
    set(
      'services',
      services.map((s, j) => (j === i ? { ...s, ...change } : s)),
    )
  const add = () => {
    set('services', [...services, { name: '', description: '', price: '' }])
    rows.setOpen(services.length)
    setTimeout(() => document.getElementById(`kn-svc-${services.length}`)?.focus(), 0)
  }
  const remove = (i: number) => {
    set('services', services.filter((_, j) => j !== i))
    rows.setOpen(null)
  }
  return (
    <Section
      id="kn-services"
      title="Services and prices"
      description={`${name} quotes only these prices. Leave a price empty for quote only.`}
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={!canEdit || services.length >= SERVICES_MAX}
          onClick={add}
          title="Add a service"
        >
          Add
        </Button>
      }
    >
      {services.length === 0 ? (
        <ListEmpty>No services yet. Without prices here, {name} never names a price and offers a call back.</ListEmpty>
      ) : (
        <List label="Services and prices">
          {services.map((s, i) => {
            const open = rows.open === i || !s.name.trim()
            return (
              <ListRow
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; an index is their identity
                key={i}
                title={s.name.trim() || <span className="kn-untitled">New service</span>}
                sub={s.description.trim() || undefined}
                aside={<span className={s.price.trim() ? 'kn-price-tag' : 'help'}>{s.price.trim() || 'Quote only'}</span>}
                actions={<RowActions what={s.name || 'service'} open={open} canEdit={canEdit} onEdit={() => rows.toggle(i)} onRemove={() => remove(i)} />}
                below={
                  open && (
                    <div className="kn-edit kn-svc-fields">
                      <Input
                        id={`kn-svc-${i}`}
                        value={s.name}
                        placeholder="Service"
                        aria-label="Service"
                        invalid={!s.name.trim() && rows.open !== i}
                        onChange={e => update(i, { name: e.target.value })}
                      />
                      <Input
                        value={s.price}
                        placeholder="e.g. $43 or quote only"
                        aria-label="Price"
                        maxLength={PRICE_MAX}
                        className="kn-price"
                        onChange={e => update(i, { price: e.target.value })}
                      />
                      <Input
                        value={s.description}
                        placeholder="Short description (optional)"
                        aria-label="Description"
                        className="kn-desc"
                        onChange={e => update(i, { description: e.target.value })}
                      />
                    </div>
                  )
                }
              />
            )
          })}
        </List>
      )}
      {services.length > 0 && (
        <span className="help">
          {services.length} / {SERVICES_MAX}
        </span>
      )}
    </Section>
  )
}

function FaqsCard({ draft, set, canEdit }: Props) {
  const faqs = draft.faqs
  const rows = useOpenRow()
  const update = (i: number, change: Partial<Draft['faqs'][number]>) =>
    set(
      'faqs',
      faqs.map((f, j) => (j === i ? { ...f, ...change } : f)),
    )
  const add = () => {
    set('faqs', [...faqs, { q: '', a: '' }])
    rows.setOpen(faqs.length)
    setTimeout(() => document.getElementById(`kn-faq-${faqs.length}`)?.focus(), 0)
  }
  const remove = (i: number) => {
    set('faqs', faqs.filter((_, j) => j !== i))
    rows.setOpen(null)
  }
  return (
    <Section
      id="kn-faqs"
      title="FAQs"
      description="Questions callers ask, with the answer to give."
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={!canEdit || faqs.length >= FAQS_MAX}
          onClick={add}
          title="Add a question"
        >
          Add
        </Button>
      }
    >
      {faqs.length === 0 ? (
        <ListEmpty>No FAQs yet.</ListEmpty>
      ) : (
        <List label="FAQs">
          {faqs.map((f, i) => {
            const open = rows.open === i || !f.q.trim() || !f.a.trim()
            return (
              <ListRow
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; an index is their identity
                key={i}
                title={f.q.trim() || <span className="kn-untitled">New question</span>}
                sub={f.a.trim() ? <span className="kn-answer">{f.a.trim()}</span> : undefined}
                actions={<RowActions what="this FAQ" open={open} canEdit={canEdit} onEdit={() => rows.toggle(i)} onRemove={() => remove(i)} />}
                below={
                  open && (
                    <div className="kn-edit kn-faq-fields">
                      <Input
                        id={`kn-faq-${i}`}
                        value={f.q}
                        placeholder="Question"
                        aria-label="Question"
                        onChange={e => update(i, { q: e.target.value })}
                      />
                      <TextArea value={f.a} placeholder="Answer" label="Answer" onChange={v => update(i, { a: v })} />
                    </div>
                  )
                }
              />
            )
          })}
        </List>
      )}
      {faqs.length > 0 && (
        <span className="help">
          {faqs.length} / {FAQS_MAX}
        </span>
      )}
    </Section>
  )
}

// --- Documents -----------------------------------------------------------------------------

const TYPES: Record<string, (typeof documentTypes)[number]> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
}

function DocumentsCard({
  assistant,
  canEdit,
  toast,
  documents,
  name,
}: Props & { documents: KnowledgeDocument[]; name: string }) {
  const write = useWriteAction()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const total = documents.reduce((sum, d) => sum + d.chars, 0)
  async function upload(file: File) {
    const type = TYPES[file.name.split('.').pop()?.toLowerCase() ?? '']
    if (!type) return toast('Add a PDF, text or Markdown file.')
    if (file.size > DOCUMENT_MAX_BYTES)
      return toast(`That file is ${fileSize(file.size)}; at most ${fileSize(DOCUMENT_MAX_BYTES)}.`)
    setBusy(true)
    try {
      const data = await write<{ truncated: boolean }>('knowledge.addDocument', {
        assistantId: assistant.id,
        name: file.name,
        mimeType: type,
        data: await fileToBase64(file),
      })
      toast(data.truncated ? 'Added. It is long, so only the first part is used.' : 'Document added.')
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function remove(doc: KnowledgeDocument) {
    try {
      await write('knowledge.removeDocument', { documentId: doc.id })
      toast(`${doc.name} removed.`)
    } catch (e) {
      toast((e as Error).message)
    }
  }
  return (
    <Section
      id="kn-documents"
      title="Documents"
      description={
        documents.length
          ? `${name} uses them as reference: ${documentsUse(total)}.`
          : 'Price sheets, warranty terms, service area maps. PDF or text.'
      }
      help={`Up to ${DOCUMENTS_MAX} files of ${fileSize(DOCUMENT_MAX_BYTES)} each. Linedesk keeps their text; scanned PDFs without text can't be read. ${name} treats them as reference material and never follows instructions in them.`}
      actions={
        <>
          <input
            ref={input}
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            hidden
            onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void upload(file)
            }}
          />
          <Button
            size="sm"
            icon="attach"
            disabled={!canEdit || busy || documents.length >= DOCUMENTS_MAX}
            onClick={() => input.current?.click()}
            title="Upload a PDF or text file"
          >
            {busy ? 'Reading…' : 'Upload'}
          </Button>
        </>
      }
    >
      {documents.length > 0 && (
        <ul className="kn-list">
          {documents.map(d => (
            <li key={d.id} className="kn-row">
              <div className="kn-main">
                <b>{d.name}</b>
                <span className="kn-sub">
                  {fileSize(d.size_bytes)} · {count(d.chars)} characters of text
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                disabled={!canEdit}
                aria-label={`Remove ${d.name}`}
                title="Remove"
                onClick={() => void remove(d)}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
