// Settings › Assistant › Business info: what the assistant knows about the business: questions callers asked
// that it could not answer, and About the business (with Write with help, WriteWithHelp.tsx). About is part of
// the assistant's draft (saved with Save); an answered question is added to it and saved at once.
import { answeredQuestionLine, INSTRUCTIONS_MAX } from '@linedesk/actions'
import type { Assistant, KnowledgeQuestion } from '@linedesk/db/types'
import { useState } from 'react'
import { useRows } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import type { Draft } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'
import { hasKnowledge } from './knowledgeModel.ts'
import { useWriteAction } from './settings-api.ts'
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
  const questions = useRows('knowledge_questions')
    .filter(q => q.assistant_id === assistant.id && q.status === 'open')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const empty = !hasKnowledge(draft)
  const name = draft.name.trim() || 'The assistant'

  return (
    <>
      {questions.length > 0 && <QuestionsCard {...props} questions={questions} name={name} />}
      <AboutCard {...props} name={name} empty={empty} />
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
      description="Answer once; it is added to About the business for every caller."
    >
      <ul className="kn-list">
        {questions.map(q => (
          <QuestionRow
            key={q.id}
            question={q}
            toast={toast}
            onAnswered={(q, a) => {
              // The server added it to the saved text; the draft gets it too, so unsaved edits keep it.
              const line = answeredQuestionLine(q, a)
              if (!draft.instructions.includes(line)) set('instructions', [draft.instructions.trim(), line].filter(Boolean).join('\n'))
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
  onAnswered: (question: string, answer: string) => void
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
        onAnswered(question.question, answer.trim())
        toast('Added to About the business.')
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
          title="Add the question and answer to About the business"
        >
          Add answer
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

// --- About the business --------------------------------------------------------------------

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
