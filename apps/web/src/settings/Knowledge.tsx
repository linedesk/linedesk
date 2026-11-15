// Settings › Assistant › Business info: what the assistant knows about the business, About the business (with
// Write with help, WriteWithHelp.tsx). About is part of the assistant's draft (saved with Save). Questions callers
// asked that it could not answer are answered in How <assistant> did (review/AssistantReview.tsx).
import { INSTRUCTIONS_MAX } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { Button } from '../ui/kit.tsx'
import type { Draft } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'
import { hasKnowledge } from './knowledgeModel.ts'
import { WriteWithHelp } from './WriteWithHelp.tsx'
import './knowledge.css'
import { fmt } from '../i18n/format.ts'

type Props = {
  assistant: Assistant
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  replace: (next: Draft) => void
  canEdit: boolean
  toast: (text: string) => void
}

const count = (n: number) => fmt().number(n)

export function Knowledge(props: Props) {
  const t = useT()
  const { draft } = props
  const empty = !hasKnowledge(draft)
  const name = draft.name.trim() || t('settings.knowledge.theAssistant')
  return <AboutCard {...props} name={name} empty={empty} />
}

// --- About the business --------------------------------------------------------------------

function AboutCard(props: Props & { name: string; empty: boolean }) {
  const { draft, set, name, empty, canEdit } = props
  const t = useT()
  const [helping, setHelping] = useState(false)
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
      <Field id="as-instr" label={t('settings.knowledge.label', { name })}>
        <TextArea
          id="as-instr"
          tall
          value={draft.instructions}
          onChange={v => set('instructions', v)}
          placeholder={t('settings.knowledge.placeholder')}
        />
        <span className="help">
          {t('settings.knowledge.length', {
            count: count(draft.instructions.trim().length),
            max: count(INSTRUCTIONS_MAX),
          })}
        </span>
      </Field>
      {helping && <WriteWithHelp {...props} onClose={() => setHelping(false)} />}
    </Section>
  )
}
