// Step 4: connect a Google or Microsoft calendar so the assistant can book, and pick the calendar it books into.
// The connect leaves for the provider's consent page; the callback sends the browser back to the app,
// which still shows onboarding at this step, and this screen reads the result from the address.
import { useEffect, useState } from 'react'
import { AccountRow, AddCalendar, ConnectButtons, useCalendarsReady } from '../settings/Calendar.tsx'
import { CONNECT_RETURN_KEY, calendarsOf, connectResult } from '../settings/calendarModel.ts'
import { useAssistant, useRows } from '../store.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { SkeletonRows } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'

type Props = { onBack: () => void; onNext: () => void }

/** What the OAuth callback put into the address, read once; the address is cleaned so the app opens on the inbox later. */
function useReturnFromConnect(): ReturnType<typeof connectResult> {
  const [result] = useState(() => connectResult(window.location.hash))
  useEffect(() => {
    if (!result) return
    history.replaceState(null, '', window.location.pathname)
    try {
      sessionStorage.removeItem(CONNECT_RETURN_KEY)
    } catch {}
  }, [result])
  return result
}

export function CalendarStep({ onBack, onNext }: Props) {
  const assistant = useAssistant()
  const connections = useRows('calendar_connections')
    .filter(c => c.status === 'connected')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const allCalendars = useRows('assistant_calendars')
  const calendars = assistant ? calendarsOf(allCalendars, assistant.id) : []
  const returned = useReturnFromConnect()
  const [error, setError] = useState<string | null>(returned && !returned.ok ? returned.text : null)
  // Back from a successful connect: the next thing to do is pick the calendar, so the list opens.
  const [picking, setPicking] = useState(!!returned?.ok)
  const name = assistant?.name ?? 'Your assistant'
  // Back from the consent page, the local rows are from before it: placeholders until they are read again.
  const loaded = useCalendarsReady()
  const ready = calendars.length > 0
  useStepKeys({ onEnter: picking ? undefined : onNext, onEscape: picking ? undefined : onBack })

  return (
    <>
      <div className="ob-body">
        <h1>Connect your calendar.</h1>
        <p className="ob-lede">{name} books into your free times.</p>
        {!loaded && <SkeletonRows label="Loading your calendar" rows={1} />}
        {loaded && connections.length > 0 && (
          <ul className="k-list ob-cal">
            {connections.map(c => (
              <AccountRow key={c.id} connection={c} />
            ))}
          </ul>
        )}
        {!loaded ? null : ready ? (
          <div className="ob-prompt ok">
            <Icon name="check" size={16} />
            <span>
              {name} books into {calendars.map(c => c.name).join(', ')}.
            </span>
          </div>
        ) : (
          connections.length > 0 && (
            <p className="ob2-row ob-tight">
              <Button size="sm" icon="plus" onClick={() => setPicking(true)}>
                Choose a calendar
              </Button>
            </p>
          )
        )}
        {assistant && loaded && !ready && <ConnectButtons assistantId={assistant.id} toast={setError} />}
        {error && (
          <p className="ob-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {picking && loaded && assistant && connections.length > 0 && (
        <AddCalendar
          assistant={assistant}
          connections={connections}
          initialConnectionId={returned?.connectionId}
          onClose={() => setPicking(false)}
          toast={() => setError(null)}
        />
      )}
      <Foot onBack={onBack} onContinue={onNext} canContinue label={ready ? 'Continue' : 'Skip for now'} />
    </>
  )
}
