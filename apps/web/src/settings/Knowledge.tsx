// Settings › Assistant › Knowledge: what the assistant knows about the business. Starts with the
// website import when there is nothing yet; then questions callers asked that it could not answer,
// About the business, services and prices, FAQs and documents. About, services and FAQs are part of
// the assistant's draft (saved with Save); documents and answered questions are saved at once.
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENTS_MAX,
  type documentTypes,
  FAQS_MAX,
  INSTRUCTIONS_MAX,
  type KnowledgeImportData,
  PRICE_MAX,
  SERVICES_MAX,
} from '@linedesk/actions'
import type { Assistant, KnowledgeDocument, KnowledgeQuestion } from '@linedesk/db/types'
import { useRef, useState } from 'react'
import { useRows } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import type { Draft } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'
import {
  applyImport,
  defaultPicks,
  documentsUse,
  fileSize,
  hasKnowledge,
  type ImportPicks,
  type ImportReview,
  reviewImport,
  wordDiff,
} from './knowledgeModel.ts'
import { callAction, useWriteAction } from './settings-api.ts'
import { fileToBase64 } from './voiceModel.ts'
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
  const [proposal, setProposal] = useState<KnowledgeImportData | null>(null)
  const empty = !hasKnowledge(draft, documents.length)
  const name = draft.name.trim() || 'The assistant'

  if (proposal) return <ImportReviewCard {...props} proposal={proposal} onDone={() => setProposal(null)} />
  return (
    <>
      {questions.length > 0 && <QuestionsCard {...props} questions={questions} name={name} />}
      <ImportCard {...props} name={name} onProposal={setProposal} prominent={empty} />
      <AboutCard {...props} name={name} />
      <ServicesCard {...props} name={name} />
      <FaqsCard {...props} />
      <DocumentsCard {...props} documents={documents} name={name} />
    </>
  )
}

// --- Import --------------------------------------------------------------------------------

function ImportCard({
  assistant,
  draft,
  canEdit,
  toast,
  name,
  onProposal,
  prominent,
}: Props & { name: string; onProposal: (p: KnowledgeImportData) => void; prominent?: boolean }) {
  const [url, setUrl] = useState(draft.website)
  const [profileOpen, setProfileOpen] = useState(false)
  const [profileText, setProfileText] = useState('')
  const [busy, setBusy] = useState(false)
  async function start() {
    if (!url.trim() && !profileText.trim()) return toast('Enter your website, or paste your Google Business Profile.')
    setBusy(true)
    try {
      onProposal(
        await callAction<KnowledgeImportData>('knowledge.import', {
          assistantId: assistant.id,
          ...(url.trim() ? { url: url.trim() } : {}),
          ...(profileText.trim() ? { profileText: profileText.trim() } : {}),
        }),
      )
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      id="kn-import"
      title={prominent ? `Teach ${name} about your business` : 'Import'}
      description={
        prominent
          ? 'Start from your website. You review everything before it is used.'
          : draft.website
            ? `Last imported from ${draft.website.replace(/^https?:\/\//, '')}`
            : undefined
      }
      help="Linedesk reads your home page and up to five pages it links to (services, prices, about, contact, FAQ), respecting robots.txt, and drafts an About text, services and FAQs. Nothing changes until you pick what to keep and save."
    >
      <div className="kn-import">
        <Input
          id="kn-url"
          value={url}
          placeholder="yourbusiness.com"
          aria-label="Website"
          disabled={!canEdit || busy}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void start()
            }
          }}
        />
        <Button
          variant={prominent ? 'primary' : 'secondary'}
          disabled={!canEdit || busy}
          onClick={() => void start()}
          title="Read the website and draft the knowledge for review"
        >
          {busy ? 'Reading…' : prominent ? 'Import from your website' : 'Import again'}
        </Button>
      </div>
      {busy && <p className="help">Reading the pages and drafting a summary. This takes up to a minute.</p>}
      {profileOpen ? (
        <Field
          id="kn-profile"
          label="Google Business Profile"
          aside="Optional"
          help="Copy the text of your profile (services, hours, Q&A) and paste it here."
        >
          <TextArea
            id="kn-profile"
            value={profileText}
            onChange={setProfileText}
            placeholder="Brightwater Plumbing & Heating · Plumber in Portland, Oregon…"
          />
        </Field>
      ) : (
        <button type="button" className="kn-link" disabled={!canEdit} onClick={() => setProfileOpen(true)}>
          Add your Google Business Profile
        </button>
      )}
    </Section>
  )
}

function ImportReviewCard({
  draft,
  replace,
  toast,
  proposal,
  onDone,
}: Props & { proposal: KnowledgeImportData; onDone: () => void }) {
  const [review] = useState<ImportReview>(() => reviewImport(draft, proposal))
  const [picks, setPicks] = useState<ImportPicks>(() => defaultPicks(review))
  const nothing = review.about === 'same' && !review.services.length && !review.faqs.length
  const toggle = (list: 'services' | 'faqs', i: number) =>
    setPicks(p => {
      const next = new Set(p[list])
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return { ...p, [list]: next }
    })
  function take() {
    replace(applyImport(draft, proposal, review, picks))
    toast('Added to the draft. Check it, then save.')
    onDone()
  }
  const read = proposal.pages.length
    ? `Read ${proposal.pages.length} page${proposal.pages.length === 1 ? '' : 's'}`
    : 'From the pasted profile'
  return (
    <Section
      id="kn-review"
      title="Review the import"
      description={`${read}. Pick what to keep; nothing is saved until you save.`}
    >
      {proposal.pages.length > 0 && (
        <ul className="kn-pages">
          {proposal.pages.map(p => (
            <li key={p.url} title={p.url}>
              {p.title || p.url}
            </li>
          ))}
        </ul>
      )}
      {nothing && (
        <p className="help">
          Nothing new: everything it found is already here{review.unchanged ? ` (${review.unchanged} items)` : ''}.
        </p>
      )}
      {review.about !== 'same' && (
        <div className="kn-review-block">
          <label className="kn-pick">
            <input
              type="checkbox"
              checked={picks.about}
              onChange={e => setPicks(p => ({ ...p, about: e.target.checked }))}
            />
            <b>
              {review.about === 'empty' ? 'Use as About the business' : 'Replace your About text with the imported one'}
            </b>
          </label>
          <p className="help kn-about-note">
            This text becomes {draft.name.trim() || 'the assistant'}'s instructions on every call. Read it through and
            fix anything that is wrong before you save.
          </p>
          <p className="kn-about-text">
            {review.about === 'empty'
              ? proposal.about
              : wordDiff(draft.instructions, proposal.about).map((part, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff parts never reorder
                  <span key={i} className={cx(part.kind === 'added' && 'kn-add', part.kind === 'removed' && 'kn-del')}>
                    {part.text}
                  </span>
                ))}
          </p>
        </div>
      )}
      {review.services.length > 0 && (
        <div className="kn-review-block">
          <b className="kn-review-h">Services and prices</b>
          {review.services.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this review
            <label key={i} className="kn-pick">
              <input type="checkbox" checked={picks.services.has(i)} onChange={() => toggle('services', i)} />
              <span>
                {p.item.name} · {p.item.price || 'Quote only'}
                {p.was && <span className="kn-was"> was {p.was.price || 'quote only'}</span>}
                {p.item.description && <span className="kn-sub">{p.item.description}</span>}
              </span>
              <span className="kn-tag">{p.status === 'new' ? 'New' : 'Changed'}</span>
            </label>
          ))}
        </div>
      )}
      {review.faqs.length > 0 && (
        <div className="kn-review-block">
          <b className="kn-review-h">FAQs</b>
          {review.faqs.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list for this review
            <label key={i} className="kn-pick">
              <input type="checkbox" checked={picks.faqs.has(i)} onChange={() => toggle('faqs', i)} />
              <span>
                {p.item.q}
                <span className="kn-sub">{p.item.a}</span>
                {p.was && <span className="kn-sub kn-was">Yours: {p.was.a}</span>}
              </span>
              <span className="kn-tag">{p.status === 'new' ? 'New' : 'Changed'}</span>
            </label>
          ))}
        </div>
      )}
      <div className="kn-foot">
        <Button variant="ghost" onClick={onDone} title="Close without changing anything">
          Discard
        </Button>
        {!nothing && (
          <Button variant="primary" onClick={take} title="Put the picked parts into the draft">
            Add to draft
          </Button>
        )}
      </div>
    </Section>
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

function AboutCard({ draft, set, name }: Props & { name: string }) {
  return (
    <Section
      id="as-instructions"
      title="About the business"
      description="Write it like you would brief a new hire."
      help={`What ${name} should know and how to answer: what you do, the area you cover, how you handle prices, what to ask callers. Opening hours go under Settings, Business hours; ${name} reads them from there.`}
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
    </Section>
  )
}

function ServicesCard({ draft, set, canEdit, name }: Props & { name: string }) {
  const services = draft.services
  const update = (i: number, change: Partial<Draft['services'][number]>) =>
    set(
      'services',
      services.map((s, j) => (j === i ? { ...s, ...change } : s)),
    )
  const add = () => {
    set('services', [...services, { name: '', description: '', price: '' }])
    setTimeout(() => document.getElementById(`kn-svc-${services.length}`)?.focus(), 0)
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
        <p className="help">No services yet. Without prices here, {name} never names a price and offers a call back.</p>
      ) : (
        <ul className="kn-list">
          {services.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; an index is their identity
            <li key={i} className="kn-row kn-service">
              <div className="kn-svc-fields">
                <Input
                  id={`kn-svc-${i}`}
                  value={s.name}
                  placeholder="Service"
                  aria-label="Service"
                  onChange={e => update(i, { name: e.target.value })}
                />
                <Input
                  value={s.price}
                  placeholder="Quote only"
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
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                aria-label={`Remove ${s.name || 'service'}`}
                title="Remove"
                onClick={() =>
                  set(
                    'services',
                    services.filter((_, j) => j !== i),
                  )
                }
              />
            </li>
          ))}
        </ul>
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
  const update = (i: number, change: Partial<Draft['faqs'][number]>) =>
    set(
      'faqs',
      faqs.map((f, j) => (j === i ? { ...f, ...change } : f)),
    )
  const add = () => {
    set('faqs', [...faqs, { q: '', a: '' }])
    setTimeout(() => document.getElementById(`kn-faq-${faqs.length}`)?.focus(), 0)
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
        <p className="help">No FAQs yet.</p>
      ) : (
        <ul className="kn-list">
          {faqs.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; an index is their identity
            <li key={i} className="kn-row">
              <div className="kn-faq-fields">
                <Input
                  id={`kn-faq-${i}`}
                  value={f.q}
                  placeholder="Question"
                  aria-label="Question"
                  onChange={e => update(i, { q: e.target.value })}
                />
                <TextArea value={f.a} placeholder="Answer" label="Answer" onChange={v => update(i, { a: v })} />
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon="close"
                aria-label="Remove this FAQ"
                title="Remove"
                onClick={() =>
                  set(
                    'faqs',
                    faqs.filter((_, j) => j !== i),
                  )
                }
              />
            </li>
          ))}
        </ul>
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
