// The go-live checklist (goLive.ts) in the inbox: a side panel on wide windows, a card above the calls on
// narrow ones (collapsed to one line there until opened). Each row links to where it is done and ticks
// itself: numbers, calendars and calls come from the local store, push, team and the calendar providers from their
// cached reads, forwarding, the dismissal and the steps set aside from onboarding.goLiveChecklist.
// Each open step can be put off ("Remind me", H, like a call: back by itself in 3, 7 or 30 days, for you) or marked
// "Not needed" (⌫, with Undo: for the whole workspace, or for you alone on a step about your own devices,
// goLiveStepScope); both are listed collapsed under the open steps, one click (or ⇧H, ⇧⌫) brings one back.
// A write the server refuses is undone (undoGoLiveRefusal, from the app's one rejection toast).
import { type GoLiveChecklistData, type GoLiveStepState, isRealCall } from '@linedesk/actions'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { peekStoredQuery, refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { useCalendarProviders } from '../settings/calendar-providers.ts'
import { readAction } from '../settings/settings-api.ts'
import { anchoredStyle } from '../shell/Overlays.tsx'
import { useVoiceHealth } from '../shell/presence.ts'
import { useNotificationQuery } from '../shell/useCallNotifications.ts'
import { useNow } from '../shell/useNow.ts'
import type { Toaster } from '../shell/useToast.ts'
import { useAssistantName, useRows, useRun } from '../store.tsx'
import { useTeam } from '../team/team-api.ts'
import { Backdrop } from '../ui/Backdrop.tsx'
import { type CommandItem, CommandMenu } from '../ui/CommandMenu.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { useLoadState } from '../ui/LoadStates.tsx'
import { useMediaQuery } from '../ui/useMediaQuery.ts'
import {
  calendarReady,
  canSkipGoLiveStep,
  forwardedCallArrived,
  forwardingFacts,
  type GoLiveId,
  type GoLiveItem,
  goLiveDate,
  goLiveItems,
  goLiveProgress,
  goLiveSettled,
  goLiveShown,
  goLiveView,
  teamInvited,
} from './goLive.ts'

const CHECKLIST = 'golive.checklist'
const loadChecklist = () => readAction<GoLiveChecklistData>('onboarding.goLiveChecklist')
/** Remounting the inbox (closing a call) within this window does not read it again. */
const FRESH_MS = 60_000

/**
 * What this tab did with the checklist, per workspace: closed or reopened (wins over an answer the server
 * gave before the outbox sent it), and opened from ⌘K (shown even when everything is done, and expanded).
 */
type Local = { dismissed?: boolean; pinned: boolean; expandedAt: number }
const local = new Map<string, Local>()
const localListeners = new Set<() => void>()
const NONE: Local = { pinned: false, expandedAt: 0 }
function setLocal(workspaceId: string, change: Partial<Local>) {
  local.set(workspaceId, { ...(local.get(workspaceId) ?? NONE), ...change })
  for (const listener of localListeners) listener()
}
function useLocal(workspaceId: string): Local {
  const subscribe = useCallback((listener: () => void) => {
    localListeners.add(listener)
    return () => localListeners.delete(listener)
  }, [])
  return useSyncExternalStore(subscribe, () => local.get(workspaceId) ?? NONE)
}

/**
 * The checklist facts from the server, with this tab's own close or reopen applied; undefined for members
 * (only owners and admins set up). Once settled (goLiveSettled) it is only read again on refreshGoLiveChecklist().
 */
export function useGoLiveChecklist(canEdit: boolean, workspaceId: string): GoLiveChecklistData | undefined {
  return useGoLiveChecklistQuery(canEdit, workspaceId).data
}

function useGoLiveChecklistQuery(canEdit: boolean, workspaceId: string) {
  const own = useLocal(workspaceId)
  const withOwn = (answer: GoLiveChecklistData | undefined) =>
    answer && own.dismissed !== undefined ? { ...answer, dismissed: own.dismissed } : answer
  // Settled is decided from the answer already there (also one kept from an earlier page load), before loading.
  const idle = canEdit && goLiveSettled(withOwn(peekStoredQuery<GoLiveChecklistData>(CHECKLIST)))
  const query = useQuery<GoLiveChecklistData>(canEdit ? CHECKLIST : null, loadChecklist, {
    persist: true,
    freshMs: FRESH_MS,
    idle,
  })
  return { data: withOwn(query.data), error: query.error, reload: query.reload }
}

/** After a write that verifies forwarding (the phone setup's check): the row ticks at once. */
export const refreshGoLiveChecklist = () => refreshQuery(CHECKLIST)

/** The checklist's writes: shown at once in this tab's answer, so a refusal has to undo them. */
const CHECKLIST_WRITES = new Set([
  'onboarding.skipGoLiveStep',
  'onboarding.remindGoLiveStep',
  'onboarding.restoreGoLiveStep',
  'onboarding.dismissGoLiveChecklist',
  'onboarding.reopenGoLiveChecklist',
])

/**
 * The server refused one of the checklist's writes (the rejection toast says so): this tab's own close or reopen is
 * forgotten and the answer read again, so the checklist shows what is really stored.
 */
export function undoGoLiveRefusal(workspaceId: string, action: string) {
  if (!CHECKLIST_WRITES.has(action)) return
  if (action === 'onboarding.dismissGoLiveChecklist' || action === 'onboarding.reopenGoLiveChecklist')
    setLocal(workspaceId, { dismissed: undefined })
  void refreshGoLiveChecklist()
}

/** Whether the checklist is on screen: the "Connect your number" banner stays away meanwhile (it is the first step). */
let visible = false
const visibleListeners = new Set<() => void>()
function setVisible(value: boolean) {
  if (visible === value) return
  visible = value
  for (const listener of visibleListeners) listener()
}
const subscribeVisible = (listener: () => void) => {
  visibleListeners.add(listener)
  return () => visibleListeners.delete(listener)
}
export const useGoLiveVisible = () => useSyncExternalStore(subscribeVisible, () => visible)

/** ⌘K "Show go-live checklist": reopens it after it was closed, and opens its steps. Undefined where it does not apply. */
export function useShowGoLive(canEdit: boolean, workspaceId: string): (() => void) | undefined {
  const server = useGoLiveChecklist(canEdit, workspaceId)
  const run = useRun()
  if (!canEdit || !server?.shown) return undefined
  return () => {
    const wasDismissed = server.dismissed
    setLocal(workspaceId, {
      dismissed: false,
      pinned: true,
      expandedAt: Date.now(),
    })
    setQueryData<GoLiveChecklistData | undefined>(CHECKLIST, prev => (prev ? { ...prev, dismissed: false } : prev), {
      persist: true,
    })
    if (wasDismissed) void run('onboarding.reopenGoLiveChecklist', {})
  }
}

/** Whether a real caller has called: in the local store at once, or (older calls not synced) per the server. */
export function useHadRealCall(server: GoLiveChecklistData | undefined): boolean {
  const calls = useRows('calls')
  return useMemo(() => Boolean(server?.firstRealCall) || calls.some(isRealCall), [calls, server?.firstRealCall])
}

/** The voice service was not working (not set up, or failing) at some point on this page: its row stays, ticked once it works. */
let voiceWasMissing = false

function useItems(
  server: GoLiveChecklistData | undefined,
  calendarProviders: readonly string[] | null,
  canFixVoice: boolean,
): GoLiveItem[] {
  const assistant = useAssistantName()
  const voice = useVoiceHealth()
  if (voice && (!voice.ready || voice.failing)) voiceWasMissing = true
  const numbers = useRows('phone_numbers')
  const calls = useRows('calls')
  const connections = useRows('calendar_connections')
  const attached = useRows('assistant_calendars')
  const firstRealCall = useHadRealCall(server)
  const push = useNotificationQuery().data?.push
  const team = useTeam().data
  const calendarConnected = calendarReady(connections, attached)
  return goLiveItems(
    {
      // Only on an install where it is (or was, on this page) not working; unknown yet: no row.
      voice: voiceWasMissing && voice ? { ...voice, canFix: canFixVoice } : null,
      hasNumber: numbers.length > 0,
      ...forwardingFacts(numbers),
      forwardingVerified: Boolean(server?.forwardingVerified) || forwardedCallArrived(calls, numbers),
      firstRealCall,
      // No calendar provider on this install: no row (unless one is connected anyway). Waited for like push.
      calendarConnected: calendarConnected || calendarProviders?.length ? calendarConnected : null,
      // Push not set up on this install: no row. (The checklist waits until these settings have loaded.)
      pushOn: push?.publicKey ? push.devices.length > 0 : null,
      teamInvited: Boolean(team && teamInvited(team)),
    },
    assistant,
  )
}

const DAY_MS = 86_400_000
const PICKER_WIDTH = 240
type RemindOption = CommandItem & { days: 3 | 7 | 30 }
const remindOptions = (now: Date): RemindOption[] =>
  ([3, 7, 30] as const).map(days => ({
    label: `In ${days} days`,
    icon: 'clock',
    hint: goLiveDate(new Date(now.getTime() + days * DAY_MS)),
    days,
  }))

type Props = {
  canEdit: boolean
  workspaceId: string
  toaster: Pick<Toaster, 'show' | 'via'>
  /** Registers the undo of "Not needed" with the app's Undo (Z and the toast's button). */
  undoable: (label: string, key: string, revert: () => void) => void
  /** The product tour is open: the checklist does not open itself and leaves the keys to the tour. */
  quiet?: boolean
  /** An instance admin: the voice service row links to Admin › Providers; others are told whom to ask. */
  canFixVoice?: boolean
}

export function GoLiveChecklist({
  canEdit,
  workspaceId,
  toaster,
  undoable,
  quiet = false,
  canFixVoice = false,
}: Props) {
  const query = useGoLiveChecklistQuery(canEdit, workspaceId)
  const server = query.data
  const calendarProviders = useCalendarProviders(canEdit)
  const items = useItems(server, calendarProviders, canFixVoice)
  const own = useLocal(workspaceId)
  const run = useRun()
  // A later step comes back by itself at its date.
  const now = useNow(60_000)
  const view = goLiveView(items, server?.steps, now)
  // Narrow windows: one line until opened. Wide windows: a side panel, always open (same width as app.css).
  const wide = useMediaQuery('(min-width: 1100px)')
  const [opened, setOpen] = useState(false)
  const open = wide || opened
  const [remindFor, setRemindFor] = useState<{ item: GoLiveItem; anchor: DOMRect } | null>(null)
  const [expanded, setExpanded] = useState<'later' | 'skipped' | null>(null)
  const panel = useRef<HTMLElement>(null)
  /** The row the focus moves to once the step the keyboard was on has left the open steps. */
  const focusNext = useRef<GoLiveId | null>(null)
  // Opened from ⌘K: the steps show on narrow windows too (once the tour, if open, has closed).
  useEffect(() => {
    if (own.expandedAt && !quiet) setOpen(true)
  }, [own.expandedAt, quiet])
  // The tour starting closes the Remind me picker: one card at a time.
  useEffect(() => {
    if (quiet) setRemindFor(null)
  }, [quiet])
  const openIds = view.open.map(item => item.id).join()
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the open steps change
  useEffect(() => {
    const id = focusNext.current
    focusNext.current = null
    // After the Remind me picker has closed and handed the focus back (to the step that has just gone).
    if (id)
      setTimeout(() => panel.current?.querySelector<HTMLElement>(`[data-step="${id}"] .golive-target`)?.focus(), 0)
  }, [openIds])
  const notificationsLoaded = useNotificationQuery().data !== undefined
  // A fresh browser has no rows until the first sync: until then the ticks would say less than is true.
  const synced = [useLoadState('phone_numbers'), useLoadState('calls'), useLoadState('calendar_connections')].every(
    state => state === 'ready',
  )
  // Push or the calendar providers not loaded yet would show a row that then goes away ("6" becoming "5"): wait for them too.
  const shown =
    canEdit &&
    synced &&
    notificationsLoaded &&
    calendarProviders !== null &&
    goLiveShown(server, items, own.pinned, now)
  // Not loaded at all (nothing kept from before): one line that says so, instead of no checklist.
  const failed = canEdit && !server && query.error !== null
  useLayoutEffect(() => {
    setVisible(shown || failed)
    return () => setVisible(false)
  }, [shown, failed])
  if (failed)
    return (
      <aside className="golive golive-problem" aria-label="Go live" role="alert">
        <span>The go-live checklist could not be loaded.</span>
        <Button size="sm" variant="ghost" onClick={() => void query.reload()}>
          Try again
        </Button>
      </aside>
    )
  if (!shown) return null
  const next = view.open[0]
  function dismiss() {
    setLocal(workspaceId, { dismissed: true, pinned: false })
    setQueryData<GoLiveChecklistData | undefined>(CHECKLIST, prev => (prev ? { ...prev, dismissed: true } : prev), {
      persist: true,
    })
    void run('onboarding.dismissGoLiveChecklist', {})
  }
  /** This tab's answer with the change applied at once; the write follows through the outbox. */
  function setSteps(change: (steps: GoLiveStepState[]) => GoLiveStepState[]) {
    setQueryData<GoLiveChecklistData | undefined>(
      CHECKLIST,
      prev => (prev ? { ...prev, steps: change(prev.steps ?? []) } : prev),
      { persist: true },
    )
  }
  /** When the keyboard is in the card, it goes on to the next open step once this one has left. */
  function leaving(item: GoLiveItem) {
    if (!panel.current?.contains(document.activeElement)) return
    const at = view.open.findIndex(open => open.id === item.id)
    if (at < 0) return
    focusNext.current = (view.open[at + 1] ?? view.open[at - 1])?.id ?? null
  }
  function skip(item: GoLiveItem) {
    if (!canSkipGoLiveStep(item.id)) return
    leaving(item)
    setSteps(steps => [...steps.filter(s => s.step !== item.id), { step: item.id, state: 'skipped', until: null }])
    void run('onboarding.skipGoLiveStep', { step: item.id })
    undoable(`Not needed: ${item.label}`, '⌫', () => restore(item.id))
  }
  function remind(item: GoLiveItem, days: 3 | 7 | 30) {
    const until = new Date(Date.now() + days * DAY_MS)
    leaving(item)
    setSteps(steps => [
      ...steps.filter(s => !(s.step === item.id && s.state === 'later')),
      { step: item.id, state: 'later', until: until.toISOString() },
    ])
    void run('onboarding.remindGoLiveStep', { step: item.id, days })
    toaster.show(`Reminder set: back on ${goLiveDate(until)}`)
  }
  function restore(id: GoLiveId) {
    setSteps(steps => steps.filter(s => s.step !== id))
    void run('onboarding.restoreGoLiveStep', { step: id })
  }
  // H and ⌫ on a step (its link, or one of its buttons): Remind me and Not needed.
  function onRowKey(event: KeyboardEvent<HTMLElement>, item: GoLiveItem) {
    if (quiet || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
    const key = event.key
    if (key !== 'h' && key !== 'Backspace') return
    event.preventDefault()
    event.stopPropagation()
    const row = event.currentTarget
    toaster.via('key', () => {
      if (key === 'h') setRemindFor({ item, anchor: row.getBoundingClientRect() })
      else if (canSkipGoLiveStep(item.id)) skip(item)
    })
  }
  // Esc inside the open card collapses it to its one line (narrow windows; the wide panel stays open) and keeps
  // focus on its toggle. Closing for good stays the X.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (quiet || event.key !== 'Escape' || wide || !opened) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    event.currentTarget.querySelector<HTMLButtonElement>('.golive-toggle')?.focus()
  }
  const toggleSet = (set: 'later' | 'skipped') => setExpanded(e => (e === set ? null : set))
  // ⇧H on a reminded step clears its reminder (as on a call), ⇧⌫ on a step not needed brings it back (the opposite of ⌫).
  function onBackKey(event: KeyboardEvent<HTMLElement>, id: GoLiveId, key: 'H' | 'Backspace') {
    if (quiet || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.key !== key) return
    event.preventDefault()
    event.stopPropagation()
    toaster.via('key', () => restore(id))
  }
  return (
    <aside ref={panel} className={cx('golive', open && 'is-open')} aria-label="Go live" onKeyDown={onKeyDown}>
      <div className="golive-head">
        {wide ? (
          <div className="golive-toggle">
            <b>Go live</b>
            <span className="golive-count">{goLiveProgress(view)}</span>
          </div>
        ) : (
          <button
            type="button"
            className="golive-toggle"
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
            title={open ? 'Hide the steps (Esc)' : 'Show the steps (Enter)'}
          >
            <b>Go live</b>
            <span className="golive-count">{goLiveProgress(view)}</span>
            {next && !open && <span className="golive-next">{next.label}</span>}
          </button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          aria-label="Close the checklist"
          title="Close the checklist"
          onClick={dismiss}
        />
      </div>
      <ol className="golive-rows">
        {view.rows.map(item => (
          <li
            key={item.id}
            data-step={item.id}
            className={cx('golive-row', item.done && 'is-done')}
            onKeyDown={item.done ? undefined : event => onRowKey(event, item)}
          >
            <span className="golive-mark" aria-hidden="true">
              {item.done && <Icon name="check" size={12} />}
            </span>
            {item.href && !item.done ? (
              <a href={item.href} className="golive-target">
                <b>{item.label}</b>
                <span>{item.hint}</span>
              </a>
            ) : (
              // The first real call (and the voice service, for a member) has nothing to open; it still takes the focus, for H.
              <div className={item.done ? undefined : 'golive-target'} tabIndex={item.done ? undefined : 0}>
                <b>{item.label}</b>
                {!item.done && <span>{item.hint}</span>}
              </div>
            )}
            {!item.done && (
              <span className="golive-acts">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="clock"
                  aria-label={`Remind me: ${item.label}`}
                  title="Remind me (H)"
                  onClick={event =>
                    setRemindFor({ item, anchor: event.currentTarget.closest('li')!.getBoundingClientRect() })
                  }
                />
                {canSkipGoLiveStep(item.id) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="close"
                    aria-label={`Not needed: ${item.label}`}
                    title={item.scope === 'person' ? 'Not needed for me (⌫)' : 'Not needed (⌫)'}
                    onClick={() => skip(item)}
                  />
                )}
              </span>
            )}
            <span className="sr-only">{item.done ? 'Done' : 'Not done yet'}</span>
          </li>
        ))}
      </ol>
      {(view.later.length > 0 || view.skipped.length > 0) && (
        <div className="golive-set">
          {view.later.length > 0 && (
            <>
              <button
                type="button"
                className="golive-more"
                aria-expanded={expanded === 'later'}
                title={expanded === 'later' ? 'Hide the reminders (Enter)' : 'Show the reminders (Enter)'}
                onClick={() => toggleSet('later')}
              >
                <Icon name="down" size={12} />
                Reminders · {view.later.length}
                <span>(next on {goLiveDate(view.later[0]!.until)})</span>
              </button>
              {expanded === 'later' && (
                <ul>
                  {view.later.map(({ item, until }) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="golive-back"
                        title="Clear reminder (⇧H)"
                        onClick={() => restore(item.id)}
                        onKeyDown={event => onBackKey(event, item.id, 'H')}
                      >
                        <b>{item.label}</b>
                        <span>Back on {goLiveDate(until)}</span>
                        <Icon name="restart" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {view.skipped.length > 0 && (
            <>
              <button
                type="button"
                className="golive-more"
                aria-expanded={expanded === 'skipped'}
                title={
                  expanded === 'skipped' ? 'Hide the steps not needed (Enter)' : 'Show the steps not needed (Enter)'
                }
                onClick={() => toggleSet('skipped')}
              >
                <Icon name="down" size={12} />
                Not needed · {view.skipped.length}
              </button>
              {expanded === 'skipped' && (
                <ul>
                  {view.skipped.map(item => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="golive-back"
                        title="Needed after all (⇧⌫)"
                        onClick={() => restore(item.id)}
                        onKeyDown={event => onBackKey(event, item.id, 'Backspace')}
                      >
                        <b>{item.label}</b>
                        <span>Bring back</span>
                        <Icon name="restart" size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
      {remindFor && (
        <Backdrop onClose={() => setRemindFor(null)} anchored>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Esc closes the picker, not the card behind it */}
          <div
            className="k-cmd-anchored"
            style={anchoredStyle(remindFor.anchor, PICKER_WIDTH)}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              setRemindFor(null)
            }}
          >
            <CommandMenu
              numbered
              label="Remind me"
              placeholder="Remind me…"
              groups={[{ label: remindFor.item.label, items: remindOptions(now) }]}
              onSelect={(option, via) => {
                setRemindFor(null)
                toaster.via(via, () => remind(remindFor.item, option.days))
              }}
            />
          </div>
        </Backdrop>
      )}
    </aside>
  )
}
