// A small "Edit business hours" icon next to the words "business hours" in any setting that depends on them (outside-hours greeting and
// instructions, transfer, when an appointment type may be booked): the same editor as Settings ›
// Business hours in a dialog, so the hours can be changed without leaving the page. As there, the
// switch and the time zone save at once and the weekly grid is a draft with Cancel / Save (⌘S).
import { type KeyboardEvent, useState } from 'react'
import { useRun } from '../store.tsx'
import { Switch } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { HoursGrid, TimeZoneSelect, useBusinessHours } from './BusinessHours.tsx'
import { patchWorkspaceSettings } from './settings-api.ts'

type Props = {
  canEdit: boolean
  /** The tooltip and accessible name of the icon, or the button's text. */
  label?: string
  /**
   * `icon` (the default): a small pencil right next to the words "business hours" in a setting. `button`: a
   * labelled button, where the hours are the subject (Assistant › Hours & holidays).
   */
  variant?: 'icon' | 'button'
}

/** Opens the business hours in a dialog. */
export function EditBusinessHours({ canEdit, label = 'Edit business hours', variant = 'icon' }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {variant === 'icon' ? (
        <Button
          size="sm"
          variant="ghost"
          icon="pencil"
          className="bh-edit-icon"
          onClick={() => setOpen(true)}
          title={label}
          aria-label={label}
        />
      ) : (
        <Button size="sm" variant="ghost" icon="clock" onClick={() => setOpen(true)} title="Change your business hours">
          {label}
        </Button>
      )}
      {open && <BusinessHoursDialog canEdit={canEdit} onClose={() => setOpen(false)} />}
    </>
  )
}

function BusinessHoursDialog({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const run = useRun()
  const hours = useBusinessHours()
  const { saved, days, timeZone, on, dirty, problem } = hours
  const [tried, setTried] = useState(false)
  const save = () => {
    setTried(true)
    if (problem) return
    hours.save()
    onClose()
  }
  const changeTimeZone = (zone: string) => {
    patchWorkspaceSettings({ timeZone: zone })
    void run('workspace.updateSettings', { timeZone: zone })
  }
  // Inside a page that is a form itself (Settings › Assistant): ⌘S saves the hours, not the page.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return
    e.preventDefault()
    e.stopPropagation()
    if (canEdit && dirty) save()
  }
  return (
    <Dialog
      title="Business hours"
      description="For every assistant: what callers hear, transfers and bookings."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          {canEdit && (
            <Button variant="primary" disabled={!dirty} shortcut={['⌘', 'S']} title="Save (⌘S)" onClick={save}>
              Save
            </Button>
          )}
        </>
      }
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: catches ⌘S from the fields inside */}
      <div className="bh-dialog" onKeyDown={onKeyDown}>
        <Loading
          what="Business hours"
          loading={!saved}
          error={hours.loadError}
          onRetry={() => void hours.retry()}
          skeleton={<SkeletonRows rows={7} columns={3} />}
        >
          <span className="bh-main">
            <span className="help">Use business hours</span>
            <Switch on={on} onChange={hours.setOn} label="Use business hours" disabled={!canEdit} />
          </span>
          {on ? (
            <>
              <HoursGrid days={days} set={hours.set} canEdit={canEdit} />
              <span className="st-tz">
                <span className="help" style={{ whiteSpace: 'nowrap' }}>
                  Times in
                </span>
                <TimeZoneSelect value={timeZone} onChange={changeTimeZone} disabled={!canEdit} />
              </span>
              {tried && problem && (
                <p className="k-field-msg" role="alert">
                  {problem}
                </p>
              )}
            </>
          ) : (
            <p className="help">
              Off: bookings use Monday to Friday, 9 to 5; transfers and greetings do not depend on the time.
            </p>
          )}
        </Loading>
      </div>
    </Dialog>
  )
}
