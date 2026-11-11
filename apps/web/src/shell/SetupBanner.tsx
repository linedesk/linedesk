// Says so while the assistant cannot answer calls because no number is connected; gone once one is.
import { useAssistantName, useRows } from '../store.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { useLoadState } from '../ui/LoadStates.tsx'

export function SetupBanner({ canEdit, onConnect }: { canEdit: boolean; onConnect: () => void }) {
  const hasNumber = useRows('phone_numbers').length > 0
  const name = useAssistantName()
  // A fresh browser has no rows until the first sync: only a synced empty list means no number.
  const known = useLoadState('phone_numbers') === 'ready'
  if (hasNumber || !known) return null
  return (
    <div className="setup-bar" role="status">
      <Icon name="phone-off" size={15} />
      <span>
        <b>{name} isn't answering calls yet.</b>{' '}
        {canEdit ? 'Connect a phone number to finish setup.' : 'An owner or admin needs to connect a phone number.'}
      </span>
      {canEdit && (
        <Button size="sm" variant="primary" onClick={onConnect} title="Settings, Phone numbers (G S)">
          Finish setup
        </Button>
      )}
    </div>
  )
}
