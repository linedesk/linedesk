// Above the inbox while the workspace has sample calls: says what they are, and removes them in one click.
import { useState } from 'react'
import { useWriteAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { T, useT } from '@linedesk/i18n/react'

export function SampleCallsBar({
  canEdit,
  canAssign,
  toast,
}: {
  canEdit: boolean
  /** Someone else to assign calls to: alone, A does nothing, so the line suggests H (remind) instead. */
  canAssign: boolean
  toast: (text: string) => void
}) {
  const t = useT()
  const write = useWriteAction()
  const count = useRows('calls').filter(c => c.source === 'sample' && !c.deleted_at).length
  const [busy, setBusy] = useState(false)
  if (!count) return null
  async function remove() {
    setBusy(true)
    try {
      await write('sample.remove', {})
      toast(t('inbox.sample.removed'))
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ib-sample" role="status">
      <span>
        <T
          k={canAssign ? 'inbox.sample.line' : 'inbox.sample.lineAlone'}
          values={{ count, b: chunks => <b>{chunks}</b>, done: 'E', assign: 'A', remind: 'H', open: 'Enter' }}
        />
      </span>
      {canEdit && (
        <Button
          busy={busy}
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void remove()}
          title={t('inbox.sample.removeTitle')}
        >
          {busy ? t('inbox.sample.removing') : t('inbox.sample.remove')}
        </Button>
      )}
    </div>
  )
}
