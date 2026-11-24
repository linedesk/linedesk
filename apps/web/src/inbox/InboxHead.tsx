import type { Call } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useFormat, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { assigneeTabs, callerName, type InboxTab, isTestCall, type splits, visibleSplits } from '../inbox-model.ts'
import { usePresence } from '../shell/presence.ts'
import { useNow } from '../shell/useNow.ts'
import { useAssistantName, useAssistantNameOrNull, useContact } from '../store.tsx'
import { clock, parseTs } from '../time.ts'
import { appLink } from '../ui/AppLink.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { useElapsed } from '../ui/LiveIndicator.tsx'
import { SkeletonText } from '../ui/LoadStates.tsx'
import { SearchButton, SearchField } from '../ui/listPage.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type BulkActions, BulkBar } from './BulkBar.tsx'
import { useGoLiveStepsVisible } from './GoLiveChecklist.tsx'
import { notAnsweringWhy, presenceSaidByChecklist, voiceFailing, voiceFix, voiceNotSetUp } from './goLive.ts'

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
  /** Instance admins can set up the voice stack themselves (Server admin › Providers). */
  canFixVoice?: boolean
  /** The teammate whose calls the `member` view lists. */
  memberName?: string
  /** In an assignee view: switch to another one (a picker under the title). */
  onAssigneeViews?: (anchor: DOMRect) => void
  /** In the free trial, for who sees Billing: when it ends (the first charge). The header says the days left. */
  trialEndsAt?: string | null
}

export const SEARCH_INPUT_ID = 'call-search'
const modeTitle: Partial<Record<InboxTab, MessageKey>> = {
  done: msg('inbox.view.done'),
  reminders: msg('inbox.view.reminders'),
  mine: msg('inbox.view.mine'),
  member: msg('inbox.heading.member'),
  unassigned: msg('inbox.view.unassigned'),
}

function Tabs({ tab, setTab, counts }: Pick<InboxHeadProps, 'tab' | 'setTab' | 'counts'>) {
  const t = useT()
  // Null until the assistants arrive: the tab shows a bar of the label's width, never "Handled by Assistant" first.
  const name = useAssistantNameOrNull()
  const assistant = name ?? ''
  const info: Record<(typeof splits)[number], [label: string, description: string, short?: string]> = {
    you: [t('inbox.view.you'), t('inbox.tab.youDescription')],
    ai: [t('inbox.view.ai', { assistant }), t('inbox.tab.aiDescription', { assistant }), t('inbox.tab.aiShort')],
    spam: [t('inbox.view.spam'), t('inbox.tab.spamDescription')],
  }
  return (
    <div className="ib-tabs" role="tablist" aria-label={t('inbox.tab.label')}>
      {visibleSplits(counts, tab).map((id, i) => (
        <button
          key={id}
          type="button"
          role="tab"
          className="ib-tab"
          aria-selected={tab === id}
          aria-busy={(id === 'ai' && name === null) || undefined}
          data-desc={info[id][1]}
          title={t('common.withKey', { label: info[id][0], key: String(i + 1) })}
          onClick={() => setTab(id)}
        >
          {id === 'ai' && name === null ? (
            <SkeletonText width={110} />
          ) : info[id][2] ? (
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
  const t = useT()
  return (
    <div className="ib-mode">
      <Button
        size="sm"
        variant="ghost"
        icon="left"
        title={t('common.withKey', { label: t('inbox.mode.back'), key: 'esc' })}
        onClick={() => setTab('you')}
      >
        {t('inbox.view.you')}
      </Button>
      <span className="ib-mode-sep" aria-hidden="true">
        /
      </span>
      {onSwitch ? (
        <button
          type="button"
          className="ib-mode-switch"
          title={t('inbox.mode.switch')}
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
  const t = useT()
  const assistant = useAssistantName()
  const caller = callerName(call, useContact(call.contact_id))
  const elapsed = useElapsed(parseTs(call.started_at))
  return (
    <button
      type="button"
      className="ib-maya is-live"
      title={t('inbox.presence.openLive')}
      onClick={() => onOpen?.(call)}
    >
      <span className="ib-dot" />
      {isTestCall(call) ? (
        <T k="inbox.presence.onTestCall" values={{ assistant, time: <time>{clock(elapsed)}</time> }} />
      ) : (
        <T
          k="inbox.presence.onCall"
          values={{
            assistant,
            caller: caller.startsWith('+') ? caller : caller.split(' ')[0],
            time: <time>{clock(elapsed)}</time>,
          }}
        />
      )}
    </button>
  )
}

/** What the assistant is doing right now: green only when calls are really answered. */
function Presence({ liveCall, onOpen, canFixVoice }: Pick<InboxHeadProps, 'liveCall' | 'onOpen' | 'canFixVoice'>) {
  const t = useT()
  const assistant = useAssistantNameOrNull()
  const presence = usePresence()
  const checklistSteps = useGoLiveStepsVisible()
  if (liveCall) return <LiveCallButton call={liveCall} onOpen={onOpen} />
  // Not known yet, or the name has not arrived: nothing rather than a guess (the line is not always there).
  if (presence.kind === 'unknown' || assistant === null) return null
  // The go-live checklist beside the calls says it already, with the way to fix it: once is enough.
  if (presenceSaidByChecklist(presence, checklistSteps)) return null
  if (presence.kind === 'answering') {
    return (
      <span className="ib-maya" title={t('inbox.presence.answeringCalls', { assistant })}>
        <span className="ib-dot" />
        <span className="ib-maya-t">{t('inbox.presence.answering', { assistant })}</span>
      </span>
    )
  }
  if (presence.kind === 'offline') {
    return (
      <span className="ib-maya is-off" title={t('inbox.presence.offlineTitle')}>
        <span className="ib-dot" />
        <span className="ib-maya-t">{t('inbox.presence.offline')}</span>
      </span>
    )
  }
  // No number: the mark with the consequence in words (never a bare ring); why and the link to fix it are in the setup
  // line above the inbox or the go-live checklist, so they are not said a second time here.
  if (presence.reason === 'number')
    return (
      <span className="ib-maya is-off" title={t('inbox.presence.noNumberTitle', { assistant })}>
        <StatusMark state="missing" label={t('inbox.presence.noNumberTitle', { assistant })} />
        <span className="ib-maya-t">{t('inbox.presence.cannotAnswerYet', { assistant })}</span>
      </span>
    )
  // The voice service: the same sentence as the go-live checklist's first step; the words and the fix from
  // notAnsweringWhy, which Settings › Phone numbers shows too.
  const reason = notAnsweringWhy(presence, assistant, Boolean(canFixVoice))
  if (!reason) return null
  const failing = reason.reason === 'failing'
  const why = failing
    ? voiceFailing(assistant, Boolean(reason.fix))
    : `${voiceNotSetUp(assistant)} ${voiceFix(Boolean(reason.fix))}`
  return (
    <span className="ib-maya is-off" title={why}>
      {/* Whether calls are answered is a status: the mark, never a bare grey dot (design-principles.md, Messages). */}
      <StatusMark state={failing ? 'failing' : 'missing'} label={why} />
      <span className="ib-maya-t">{reason.title}</span>
      {reason.fix && (
        <a className="ib-maya-fix" href={reason.fix.href}>
          {reason.fix.label}
        </a>
      )}
    </span>
  )
}

const DAY_MS = 86_400_000

/**
 * The free trial, quietly in the header: the days left and the first charge's date, a link to
 * Workspace settings › Billing. Today counts as a day, as on the activation step ("14 days left" on the first day).
 */
export function TrialStatus({ endsAt }: { endsAt: string }) {
  const t = useT()
  const format = useFormat()
  const now = useNow(60 * 60_000)
  const end = new Date(endsAt)
  // Ended (the page was loaded during the trial): the plan runs, nothing to count.
  if (end.getTime() <= now.getTime()) return null
  const days = Math.ceil((end.getTime() - now.getTime()) / DAY_MS)
  const date = format.date(end, { month: 'short', day: 'numeric' })
  return (
    <span className="ib-trial" title={t('inbox.trial.tip', { date: format.date(end, { dateStyle: 'long' }) })}>
      <span className="ib-trial-tag">{t('inbox.trial.tag')}</span>
      <span>{t('inbox.trial.daysLeft', { count: days })}</span>
      <span className="ib-trial-charge">{t('inbox.trial.firstCharge', { date })}</span>
      <span>
        <T k="inbox.trial.billing" values={{ link: appLink('#workspace/billing') }} />
      </span>
    </span>
  )
}

export function InboxHead({
  resultCount,
  menu,
  bulk,
  ...p
}: InboxHeadProps & { resultCount: number; menu?: ReactNode; bulk?: BulkActions }) {
  const t = useT()
  const title = modeTitle[p.tab]
  const mode = p.tab === 'member' && p.memberName ? t('inbox.view.member', { name: p.memberName }) : title && t(title)
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
        <SearchField
          id={SEARCH_INPUT_ID}
          value={p.search}
          placeholder={t('inbox.search.placeholder')}
          label={t('inbox.search.label')}
          onChange={p.onSearchChange}
          onClose={p.onSearchClose}
        />
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
      {p.search === null && p.trialEndsAt && <TrialStatus endsAt={p.trialEndsAt} />}
      {p.search === null && (
        <div className="ib-right">
          <Presence liveCall={p.liveCall} onOpen={p.onOpen} canFixVoice={p.canFixVoice} />
          <SearchButton label={t('inbox.search.label')} onClick={p.onSearch} />
        </div>
      )}
    </div>
  )
}
