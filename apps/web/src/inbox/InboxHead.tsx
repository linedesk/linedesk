import type { Call } from '@linedesk/db/types'
import type { ReactNode } from 'react'
import { assigneeTabs, callerName, type InboxTab, type splits, visibleSplits } from '../inbox-model.ts'
import { usePresence } from '../shell/presence.ts'
import { useAssistantName, useContact } from '../store.tsx'
import { clock, parseTs } from '../time.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { useElapsed } from '../ui/LiveIndicator.tsx'
import { type BulkActions, BulkBar } from './BulkBar.tsx'

export type InboxHeadProps = {
  tab: InboxTab
  setTab: (tab: InboxTab) => void
  counts: Record<InboxTab, number>
  search: string | null
  onSearch: () => void
  onSearchChange: (query: string) => void
  onSearchClose: () => void
  liveCall?: Call
  onOpen?: (call: Call) => void
  /** Instance admins can set up the voice stack themselves (Admin, Providers). */
  canFixVoice?: boolean
  /** The teammate whose calls the `member` view lists. */
  memberName?: string
  /** In an assignee view: switch to another one (a picker under the title). */
  onAssigneeViews?: (anchor: DOMRect) => void
}

export const SEARCH_INPUT_ID = 'call-search'
const modeTitle: Partial<Record<InboxTab, string>> = {
  done: 'Done',
  reminders: 'Reminders',
  mine: 'Assigned to me',
  member: 'Assigned to a teammate',
  unassigned: 'Unassigned',
  review: 'Needs review',
}

function SearchBar({
  search,
  onSearchChange,
  onSearchClose,
}: Pick<InboxHeadProps, 'onSearchChange' | 'onSearchClose'> & { search: string }) {
  return (
    <div className="ib-search">
      <Icon name="search" size={15} />
      <input
        id={SEARCH_INPUT_ID}
        value={search}
        placeholder="Search calls, callers and transcripts"
        aria-label="Search calls"
        autoComplete="off"
        onChange={e => onSearchChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
      <Button size="sm" variant="ghost" shortcut={['esc']} title="Close search (esc)" onClick={onSearchClose}>
        Close
      </Button>
    </div>
  )
}

function Tabs({ tab, setTab, counts }: Pick<InboxHeadProps, 'tab' | 'setTab' | 'counts'>) {
  const assistant = useAssistantName()
  const info: Record<(typeof splits)[number], [label: string, description: string, short?: string]> = {
    you: ['Needs you', 'Calls where someone has to act'],
    ai: [`Handled by ${assistant}`, `${assistant} resolved these on their own`, 'Handled'],
    spam: ['Spam', 'Blocked sales calls and robocalls'],
  }
  return (
    <div className="ib-tabs" role="tablist" aria-label="Views">
      {visibleSplits(counts, tab).map((id, i) => (
        <button
          key={id}
          type="button"
          role="tab"
          className="ib-tab"
          aria-selected={tab === id}
          data-desc={info[id][1]}
          title={`${info[id][0]} (${i + 1})`}
          onClick={() => setTab(id)}
        >
          {info[id][2] ? (
            <>
              <span className="ib-tab-long">{info[id][0]}</span>
              <span className="ib-tab-short">{info[id][2]}</span>
            </>
          ) : (
            info[id][0]
          )}
          {counts[id] ? <span className="n">{counts[id]}</span> : null}
        </button>
      ))}
    </div>
  )
}

type ModeProps = { title: string; count: number; setTab: (tab: InboxTab) => void; onSwitch?: (anchor: DOMRect) => void }

function Mode({ title, count, setTab, onSwitch }: ModeProps) {
  return (
    <div className="ib-mode">
      <Button size="sm" variant="ghost" icon="left" title="Back to Needs you (esc)" onClick={() => setTab('you')}>
        Needs you
      </Button>
      <span className="ib-mode-sep" aria-hidden="true">
        /
      </span>
      {onSwitch ? (
        <button
          type="button"
          className="ib-mode-switch"
          title="Show calls assigned to someone else"
          aria-haspopup="dialog"
          onClick={e => onSwitch(e.currentTarget.getBoundingClientRect())}
        >
          <b>{title}</b>
          <Icon name="down" size={14} />
        </button>
      ) : (
        <b>{title}</b>
      )}
      {count ? <span className="n">{count}</span> : null}
    </div>
  )
}

function LiveCallButton({ call, onOpen }: { call: Call; onOpen?: (call: Call) => void }) {
  const assistant = useAssistantName()
  const caller = callerName(call, useContact(call.contact_id))
  const elapsed = useElapsed(parseTs(call.started_at))
  return (
    <button type="button" className="ib-maya is-live" title="Open live call" onClick={() => onOpen?.(call)}>
      <span className="ib-dot" />
      {assistant} is on a call with {caller.startsWith('+') ? caller : caller.split(' ')[0]}{' '}
      <time>{clock(elapsed)}</time>
    </button>
  )
}

const notAnsweringWhy = {
  number: 'No phone number is connected yet, so calls do not reach the assistant.',
  voice: 'The voice service of this server is not set up yet, so calls are not answered.',
}

/** What the assistant is doing right now: green only when calls are really answered. */
function Presence({ liveCall, onOpen, canFixVoice }: Pick<InboxHeadProps, 'liveCall' | 'onOpen' | 'canFixVoice'>) {
  const assistant = useAssistantName()
  const presence = usePresence()
  if (liveCall) return <LiveCallButton call={liveCall} onOpen={onOpen} />
  if (presence.kind === 'unknown') return null
  if (presence.kind === 'answering') {
    return (
      <span className="ib-maya" title={`${assistant} is answering calls`}>
        <span className="ib-dot" />
        <span className="ib-maya-t">{assistant} is answering</span>
      </span>
    )
  }
  if (presence.kind === 'offline') {
    return (
      <span className="ib-maya is-off" title="You are offline. New calls show up once you are back online.">
        <span className="ib-dot" />
        <span className="ib-maya-t">Offline</span>
      </span>
    )
  }
  const why = notAnsweringWhy[presence.reason]
  // No number: the setup bar above the inbox already says so, with the button; the header keeps the dot.
  if (presence.reason === 'number')
    return (
      <span className="ib-maya is-off" title={why}>
        <span className="ib-dot" />
        <span className="sr-only">{assistant} is not answering yet</span>
      </span>
    )
  const fix = canFixVoice ? '#admin/providers' : null
  return (
    <span className="ib-maya is-off" title={fix ? why : `${why} Ask whoever runs this server to finish it.`}>
      <span className="ib-dot" />
      <span className="ib-maya-t">{assistant} is not answering yet</span>
      {fix && (
        <a className="ib-maya-fix" href={fix}>
          Set up
        </a>
      )}
    </span>
  )
}

export function InboxHead({
  resultCount,
  menu,
  bulk,
  ...p
}: InboxHeadProps & { resultCount: number; menu?: ReactNode; bulk?: BulkActions }) {
  const mode = p.tab === 'member' && p.memberName ? `Assigned to ${p.memberName}` : modeTitle[p.tab]
  if (bulk && bulk.count > 0)
    return (
      <div className="ib-head">
        {menu}
        <BulkBar {...bulk} />
      </div>
    )
  return (
    <div className="ib-head">
      {menu}
      {p.search !== null ? (
        <SearchBar search={p.search} onSearchChange={p.onSearchChange} onSearchClose={p.onSearchClose} />
      ) : mode ? (
        <Mode
          title={mode}
          count={resultCount}
          setTab={p.setTab}
          onSwitch={assigneeTabs.includes(p.tab) ? p.onAssigneeViews : undefined}
        />
      ) : (
        <Tabs tab={p.tab} setTab={p.setTab} counts={p.counts} />
      )}
      {p.search === null && (
        <div className="ib-right">
          <Presence liveCall={p.liveCall} onOpen={p.onOpen} canFixVoice={p.canFixVoice} />
          <Button
            size="sm"
            variant="ghost"
            icon="search"
            shortcut={['/']}
            title="Search calls (/)"
            onClick={p.onSearch}
          >
            Search
          </Button>
        </div>
      )}
    </div>
  )
}
