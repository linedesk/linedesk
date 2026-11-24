// While no number is connected (onboarding skipped or left before the phone step), one slim line above
// everything says so and leads to the phone setup; gone once a number is there, and while the go-live checklist
// (whose first step this is) is on screen. The inbox header's "can't answer calls yet" (voice service) is the other cause.
import { useAssistantName, useRows } from '../store.tsx'
import { AppLink } from '../ui/AppLink.tsx'
import { Icon } from '../ui/kit.tsx'
import { useLoadState } from '../ui/LoadStates.tsx'
import { useT } from '@linedesk/i18n/react'

const PHONE_SETUP_HASH = '#workspace/phone'

export function SetupBanner({ canEdit }: { canEdit: boolean }) {
  const t = useT()
  const hasNumber = useRows('phone_numbers').length > 0
  const name = useAssistantName()
  // A fresh browser has no rows until the first sync: only a synced empty list means no number.
  const known = useLoadState('phone_numbers') === 'ready'
  if (hasNumber || !known) return null
  return (
    <div className="setup-bar" role="status">
      <Icon name="phone-off" size={15} />
      <span>
        <b>{t('shell.setupBanner.noNumber', { assistant: name })}</b>
        {' · '}
        {canEdit ? (
          <AppLink to={PHONE_SETUP_HASH} title={t('shell.setupBanner.connectTip')}>
            {t('shell.setupBanner.connect')}
          </AppLink>
        ) : (
          t('shell.setupBanner.askAdmin')
        )}
      </span>
    </div>
  )
}
