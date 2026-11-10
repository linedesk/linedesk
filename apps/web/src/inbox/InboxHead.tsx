import type { Call } from '@callfront/db/types'
import type { ReactNode } from 'react'
import { callerName, splits, type InboxTab } from '../inbox-model.ts'
import { presenceOf, useOnline, useVoiceReady } from '../shell/presence.ts'
import { useAssistantName, useContact, useRows } from '../store.tsx'
import { clock, parseTs } from '../time.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { useElapsed } from '../ui/LiveIndicator.tsx'
import { BulkBar, type BulkActions } from './BulkBar.tsx'

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
}

export const SEARCH_INPUT_ID = 'call-search'
const modeTitle: Partial<Record<InboxTab, string>> = { done: 'Done', reminders: 'Reminders' }

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
  const info: Record<(typeof splits)[number], [label: string, description: string]> = {
    you: ['Needs you', 'Calls where someone has to act'],
    ai: [`Handled by ${assistant}`, `${assistant} resolved these on their own`],
    spam: ['Spam', 'Blocked sales calls and robocalls'],
  }
  return (
    <div className="ib-tabs" role="tablist" aria-label="Views">
      {splits.map((id, i) => (
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
          {info[id][0]}
          {counts[id] ? <span className="n">{counts[id]}</span> : null}
        </button>
      ))}
    </div>
  )
}

function Mode({ title, count, setTab }: { title: string; count: number; setTab: (tab: InboxTab) => void }) {
  return (
    <div className="ib-mode">
      <Button size="sm" variant="ghost" icon="left" title="Back to Needs you (esc)" onClick={() => setTab('you')}>
        Needs you
      </Button>
      <span className="ib-mode-sep" aria-hidden="true">
        /
      </span>
      <b>{title}</b>
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
  voice: 'The voice service of this Linedesk is not set up yet, so calls are not answered.',
}

/** What the assistant is doing right now: green only when calls are really answered. */
function Presence({ liveCall, onOpen, canFixVoice }: Pick<InboxHeadProps, 'liveCall' | 'onOpen' | 'canFixVoice'>) {
  const assistant = useAssistantName()
  const presence = presenceOf({
    online: useOnline(),
    hasNumber: useRows('phone_numbers').length > 0,
    voiceReady: useVoiceReady(),
  })
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
      <span className="ib-maya is-off" title="Offline: new calls show up once the connection is back">
        <span className="ib-dot" />
        <span className="ib-maya-t">Offline</span>
      </span>
    )
  }
  const why = notAnsweringWhy[presence.reason]
  const fix = presence.reason === 'number' ? '#settings' : canFixVoice ? '#admin/providers' : null
  return (
    <span className="ib-maya is-off" title={fix ? why : `${why} Ask whoever runs your Linedesk to finish it.`}>
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
  const mode = modeTitle[p.tab]
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
        <Mode title={mode} count={resultCount} setTab={p.setTab} />
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
