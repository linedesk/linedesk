// Above the inbox while callers asked questions the assistant could not answer: one quiet line that
// leads to Settings › Assistant › Knowledge, where the owner answers them once as FAQs.
import { useAssistants, useRows } from '../store.tsx'
import { Button } from '../ui/kit.tsx'

export function KnowledgeQuestionsBar() {
  const open = useRows('knowledge_questions').filter(q => q.status === 'open')
  const assistants = useAssistants()
  if (!open.length) return null
  const assistant = assistants.find(a => a.id === open[0]!.assistant_id)
  const name = assistant?.name ?? 'The assistant'
  return (
    <div className="ib-sample" role="status">
      <span>
        <b>
          {name} couldn't answer {open.length === 1 ? 'a question' : `${open.length} questions`}.
        </b>{' '}
        Answer once and it knows next time.
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          window.location.hash = `#assistant/${open[0]!.assistant_id}/knowledge`
        }}
        title="Open Knowledge in the assistant's settings"
      >
        Answer
      </Button>
    </div>
  )
}
