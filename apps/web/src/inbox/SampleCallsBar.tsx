// Above the inbox while the workspace has sample calls: says what they are, and removes them in one click.
import { useState } from 'react'
import { useWriteAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { Button } from '../ui/kit.tsx'

export function SampleCallsBar({ canEdit, toast }: { canEdit: boolean; toast: (text: string) => void }) {
  const write = useWriteAction()
  const count = useRows('calls').filter(c => c.source === 'sample' && !c.deleted_at).length
  const [busy, setBusy] = useState(false)
  if (!count) return null
  async function remove() {
    setBusy(true)
    try {
      await write('sample.remove', {})
      toast('Sample calls removed.')
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ib-sample" role="status">
      <span>
        <b>Sample calls.</b> {count} examples of how calls land here. Try E, A and Enter on them.
      </span>
      {canEdit && (
        <Button busy={busy}
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void remove()}
          title="Remove every sample call"
        >
          {busy ? 'Removing…' : 'Remove sample calls'}
        </Button>
      )}
    </div>
  )
}
