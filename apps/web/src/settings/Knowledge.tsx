// Settings › Assistant › Business info: what the assistant knows about the business, About the business (with
// Write with help, WriteWithHelp.tsx). About is part of the assistant's draft (saved with Save). Questions callers
// asked that it could not answer are answered in How <assistant> did (review/AssistantReview.tsx).
import { INSTRUCTIONS_MAX } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useState } from 'react'
import { Button } from '../ui/kit.tsx'
import type { Draft } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'
import { hasKnowledge } from './knowledgeModel.ts'
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
  const { draft } = props
  const empty = !hasKnowledge(draft)
  const name = draft.name.trim() || 'The assistant'
  return <AboutCard {...props} name={name} empty={empty} />
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
