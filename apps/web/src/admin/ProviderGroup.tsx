// One provider group (provider-status.ts): its providers, each with Connect or Edit (the
// provider's dialog, ProviderDialog, is the one editor). Server admin › Providers shows every group but call audio (a
// status, under Server since LIN-693); the install
// walkthrough embeds the same panel one group per step, and the embedded panel never navigates away (design rule 14):
// it opens dialogs in place. Call audio is read-only: LiveKit and its SIP bridge are set in .env on the server.
// Status stays quiet: a working provider shows only its mark (the words are its tooltip), words only for a state that
// needs attention, and a group's heading shows a status only while the group has a problem (groupAttention).
// Help on demand: why the group is there sits behind the (?) next to its heading; only a problem is a visible line.
import {
  callAudioGuide,
  callAudioStep,
  type GroupStatus,
  isMultiCategory,
  type ProviderCategory,
  type ProviderLine,
  type ProviderName,
  providerCategoryLabel,
  recommendedProviders,
  type StatusState,
  statusText,
  statusWord,
  type VoicePipeline,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { HelpTip } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import type { AdminData, AdminHealth } from './api.ts'
import { isConfigured, providerState } from './model.ts'
import { OneKey } from './OneKey.tsx'
import { ProviderError } from './ProviderError.tsx'
import { Logo, providerMeta } from './ProviderLogo.tsx'
import {
  answeringWayMark,
  answeringWays,
  defaultAnsweringWay,
  keepShown,
  listsOfGroup,
  visibleProviders,
  wayAfterKey,
  wayOfCategory,
  pinnedOfList,
} from './providerList.ts'
import { groupAttention, groupHelp, groupNote, groupProblem, rowStatus } from './providerStatus.ts'
import { i18n } from '../i18n/index.tsx'

/** "Works", "Failing: Key rejected", "Partly works: voice missing", in red only when it fails. */
export function StatusWords({ status }: { status: { state: StatusState; detail: string | null } }) {
  return (
    <span className={cx('adm-status', status.state === 'failing' && 'adm-status-bad')}>
      {statusText(status, i18n())}
    </span>
  )
}

/** The two ways Answering works, as two tabs over its lists. */
const wayLabels: Record<VoicePipeline, MessageKey> = {
  realtime: msg('admin.providers.way.realtime'),
  three_stage: msg('admin.providers.way.threeStage'),
}
const wayTabId = (way: VoicePipeline) => `adm-way-tab-${way}`
const wayPanelId = 'adm-way-panel'

type WayTabsProps = {
  selected: VoicePipeline
  marks: Record<VoicePipeline, { works: boolean; inUse: boolean }>
  /** Only changes the view: which way answers is the "Which one answers calls" setting. */
  onSelect: (way: VoicePipeline) => void
}

/**
 * Answering's two ways as tabs (the inbox's tab style): a way that works shows its check, the one that answers calls
 * also an "In use" badge. Arrow keys, Home and End move between them.
 */
export function AnsweringWayTabs({ selected, marks, onSelect }: WayTabsProps) {
  const t = useT()
  return (
    <div className="ib-tabs adm-way-tabs" role="tablist" aria-label={t('admin.providers.way.tabsLabel')}>
      {answeringWays.map(way => (
        <button
          key={way}
          id={wayTabId(way)}
          type="button"
          role="tab"
          className="ib-tab"
          aria-selected={way === selected}
          aria-controls={wayPanelId}
          tabIndex={way === selected ? 0 : -1}
          onClick={() => onSelect(way)}
          onKeyDown={e => {
            const next = wayAfterKey(way, e.key)
            if (!next) return
            e.preventDefault()
            onSelect(next)
            e.currentTarget.parentElement?.querySelector<HTMLElement>(`#${wayTabId(next)}`)?.focus()
          }}
        >
          {t(wayLabels[way])}
          {marks[way].works && <StatusMark state="works" label={t('admin.providers.way.works')} />}
          {marks[way].inUse && <span className="k-badge adm-in-use">{t('admin.providers.way.inUse')}</span>}
        </button>
      ))}
    </div>
  )
}

/** Which lists are open ("Show more"), when the page holds it for every group ("Show all providers"). */
export type ListFolds = { isOpen: (key: string) => boolean; setOpen: (key: string, open: boolean) => void }

/** A list's own title: only in a group of several lists, and never the group's name again (Billing › Billing). */
const listTitle = (lists: number, label: string, groupLabel: string) =>
  lists > 1 && label !== groupLabel ? label : null

/** A group's section on the page: `#admin/providers/<group>` scrolls here. */
export const groupAnchor = (id: GroupStatus['id']) => `adm-group-${id}`

type Props = {
  group: GroupStatus
  data: AdminData
  lines: Record<ProviderName, ProviderLine>
  health: AdminHealth | null
  onOpen: (provider: ProviderName) => void
  /** One key stored for Answering. */
  onOneKey: () => Promise<void>
  /** In the install walkthrough: no heading of its own (the step has it). */
  embedded?: boolean
  /** Server admin › Providers: the page holds which lists are open. Left out: each list keeps its own. */
  folds?: ListFolds
}

export function ProviderGroup({ group, data, lines, health, onOpen, onOneKey, embedded, folds }: Props) {
  const t = useT()
  // Answering shows one of its two ways at a time (tabs); the other groups all their lists.
  const [pickedWay, setPickedWay] = useState<VoicePipeline | null>(null)
  const answering = group.id === 'answering'
  const way = pickedWay ?? defaultAnsweringWay(group, data)
  const lists = listsOfGroup(group.id).filter(l => !answering || wayOfCategory(l.category) === way)
  const note = groupNote(group)
  const help = groupHelp(group, embedded)
  const detail = groupProblem(group)?.detail
  // Only a problem is said here; a group that works shows its marks on the providers in use.
  const attention = groupAttention(group)
  const status = attention && (
    <span className={cx('adm-provcat-note', attention === 'failing' && 'adm-status-bad')}>
      <StatusMark state={attention} /> {statusWord(attention, i18n())}
    </span>
  )
  return (
    <section id={groupAnchor(group.id)} className="adm-provcat" aria-label={group.label}>
      {!embedded && (
        <h2>
          {group.label}
          {group.id === 'transcript' && <span className="adm-recommended">{t('admin.providers.recommended')}</span>}
          {help && <HelpTip text={help} />}
          {status}
        </h2>
      )}
      {embedded && status && <p className="adm-group-status">{status}</p>}
      {note && (
        <p className="help adm-problem-line">
          {note}
          {detail && <HelpTip text={detail} />}
        </p>
      )}
      {group.id === 'answering' && group.state === 'missing' && (
        <div className="adm-onekey-card">
          <OneKey disabled={!data.canStoreKeys} onDone={onOneKey} />
        </div>
      )}
      {group.id === 'call-audio' && <CallAudio group={group} health={health} />}
      {answering && (
        <AnsweringWayTabs
          selected={way}
          marks={{
            realtime: answeringWayMark('realtime', group, data, lines),
            three_stage: answeringWayMark('three_stage', group, data, lines),
          }}
          onSelect={setPickedWay}
        />
      )}
      {group.id !== 'call-audio' && (
        <div
          className="adm-provlists"
          {...(answering ? { id: wayPanelId, role: 'tabpanel', 'aria-labelledby': wayTabId(way) } : {})}
        >
          {lists.map(({ key, category, providers }) => (
            <ProviderList
              key={key}
              title={listTitle(lists.length, providerCategoryLabel(category, i18n()), group.label)}
              category={category}
              providers={providers}
              data={data}
              lines={lines}
              onOpen={onOpen}
              open={folds?.isOpen(key)}
              onOpenChange={folds ? next => folds.setOpen(key, next) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** The lists of Answering's "Three parts" tab: each says which provider is in use, also when it is the only one. */
const threeStageParts: ReadonlySet<ProviderCategory> = new Set(['stt', 'llm', 'tts'])

/**
 * Whether a list marks the provider in use with "In use": only where it is a choice (several set up, or recording,
 * off until picked), and always in the three parts of Answering, as their tab does. Never where several are used at
 * once.
 */
export function showsInUse(category: ProviderCategory, setUpCount: number): boolean {
  if (isMultiCategory(category)) return false
  return setUpCount > 1 || category === 'recording' || threeStageParts.has(category)
}

/** One category's providers, each with Connect or Edit. */
export function ProviderList({
  title,
  category,
  providers,
  data,
  lines,
  onOpen,
  open,
  onOpenChange,
}: {
  title: string | null
  category: ProviderCategory
  providers: ProviderName[]
  data: AdminData
  lines: Record<ProviderName, ProviderLine>
  onOpen: (provider: ProviderName) => void
  /** Held by the page (ListFolds); left out, the list keeps its own. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const t = useT()
  const active = data.activeProviders[category]?.provider ?? null
  const setUp = providers.filter(p => lines[p]?.state !== 'missing')
  const [ownExpanded, setOwnExpanded] = useState(false)
  const expanded = open ?? ownExpanded
  const setExpanded = onOpenChange ?? setOwnExpanded
  const keep = keepShown(data, lines)
  const list = visibleProviders(providers, { pinned: pinnedOfList(category, providers), keep, expanded })
  // "Recommended" helps to pick one: shown until a provider of the list is set up, then the marks say what is used.
  const picking = !providers.some(p => {
    const status = data.providers.find(s => s.provider === p)
    return !!status && isConfigured(status)
  })
  return (
    <>
      {title && <h3 className="adm-provsub">{title}</h3>}
      <ul className="adm-provlist">
        {list.shown.map(name => {
          const status = data.providers.find(p => p.provider === name)
          if (!status) return null
          const line = lines[name]
          const configured = isConfigured(status)
          const inUse = configured && showsInUse(category, setUp.length) && active === name
          const shown = line && rowStatus(line, { inUse, fromServer: providerState(status) === 'env' })
          return (
            <li key={name} className="adm-prov">
              <Logo mark={providerMeta[name].mark} size={28} />
              <span className="adm-prov-name">
                <b>{status.label}</b>
                {picking && recommendedProviders[category] === name && (
                  <span className="adm-recommended">{t('admin.providers.recommended')}</span>
                )}
                {configured && line && shown && (
                  <span className={cx('adm-tile-status', line.state === 'failing' && 'adm-status-bad')}>
                    <StatusMark state={line.state} label={shown.label} />
                    {shown.words}
                    {inUse && <span className="k-badge adm-in-use">{t('admin.providers.row.inUse')}</span>}
                  </span>
                )}
                {configured && line?.state === 'failing' && line.message && (
                  <ProviderError message={line.message} at={line.failedAt} />
                )}
              </span>
              <span className="adm-prov-actions">
                <Button
                  size="sm"
                  variant={configured ? 'ghost' : 'secondary'}
                  onClick={() => onOpen(name)}
                  title={
                    configured
                      ? t('admin.providers.editTip', { provider: status.label })
                      : t('admin.providers.connectTip', { provider: status.label })
                  }
                >
                  {configured ? t('admin.providers.edit') : t('admin.providers.connect')}
                </Button>
              </span>
            </li>
          )
        })}
      </ul>
      {list.foldable && (expanded || list.hidden > 0) && (
        <Button
          size="sm"
          variant="ghost"
          className="adm-provlist-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          title={
            expanded ? t('admin.providers.list.lessTip') : t('admin.providers.list.moreTip', { count: list.hidden })
          }
        >
          {expanded ? t('admin.providers.list.less') : t('admin.providers.list.more')}
        </Button>
      )}
    </>
  )
}

/** LiveKit and SIP as the server reports them, and how to set them up; nothing to edit here. */
function CallAudio({ group, health }: { group: GroupStatus; health: AdminHealth | null }) {
  const t = useT()
  const rows = [
    { label: t('admin.providers.callAudio.livekit'), status: health?.livekit },
    { label: t('admin.providers.callAudio.sip'), status: health?.sip },
  ]
  return (
    <>
      <ul className="adm-provlist">
        {rows.map(row => (
          <li key={row.label} className="adm-prov">
            <span className="adm-prov-name">
              <b>{row.label}</b>
              <span className="adm-tile-status">
                <StatusMark
                  state={!row.status ? 'checking' : row.status.ok ? 'works' : 'missing'}
                  label={row.status?.message}
                />
                {/* Working: the mark alone, its message is the tooltip. */}
                {row.status?.ok ? null : (row.status?.message ?? t('admin.providers.checking'))}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {group.state !== 'works' && <CallAudioGuide open={group.state === 'missing'} />}
    </>
  )
}

/** How to set up LiveKit and its SIP bridge: under call audio's rows here, and on Server admin › Server. */
export function CallAudioGuide({ open }: { open: boolean }) {
  const t = useT()
  return (
    <details className="adm-guide" open={open}>
      <summary>{t('admin.providers.callAudio.howTo')}</summary>
      <ol className="adm-guide-steps">
        {callAudioGuide.stepKeys
          .map(key => callAudioStep(key, i18n()))
          .map(step => (
            <li key={step}>{step}</li>
          ))}
      </ol>
      <p className="help">
        <a href={callAudioGuide.url} target="_blank" rel="noreferrer">
          {t('admin.providers.callAudio.ports')}
        </a>
        {' · '}
        {t(callAudioGuide.costKey)}
      </p>
    </details>
  )
}
