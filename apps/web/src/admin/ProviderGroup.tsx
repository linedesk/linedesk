// One provider group (provider-status.ts): its status, why it is there, and its providers, each with Connect or Edit
// (the provider's dialog, ProviderDialog, is the one editor). Admin › Providers shows every group; the install
// walkthrough embeds the same panel one group per step, and the embedded panel never navigates away (design rule 14):
// it opens dialogs in place. Call audio is read-only: LiveKit and its SIP bridge are set in .env on the server.
import {
  callAudioGuide,
  type GroupStatus,
  type ProviderCategory,
  type ProviderLine,
  type ProviderName,
  pinnedProvidersOf,
  providerCategories,
  providerSpec,
  providersOfGroup,
  recommendedProviders,
  type StatusState,
  statusText,
} from '@linedesk/actions'
import { Fragment, useState } from 'react'
import { Button, cx } from '../ui/kit.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import type { AdminData, AdminHealth } from './api.ts'
import { isConfigured, providerState } from './model.ts'
import { OneKey } from './OneKey.tsx'
import { ServerSet } from './ProviderDialog.tsx'
import { Logo, providerMeta } from './ProviderLogo.tsx'
import { visibleProviders } from './providerList.ts'
import { groupNote } from './providerStatus.ts'

/** The state at a glance: ink when it works, red when it fails, grey otherwise; a spinner while checking. */
/** "Works", "Failing: Key rejected", "Partly works: voice missing", in red only when it fails. */
export function StatusWords({ status }: { status: { state: StatusState; detail: string | null } }) {
  return <span className={cx('adm-status', status.state === 'failing' && 'adm-status-bad')}>{statusText(status)}</span>
}

/** The two ways Answering works, as headings over its lists. */
const answeringWays: Partial<Record<ProviderCategory, string>> = {
  realtime: 'One realtime model',
  stt: 'Or three parts: speech to text, a language model and a voice',
}

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
}

export function ProviderGroup({ group, data, lines, health, onOpen, onOneKey, embedded }: Props) {
  const providers = providersOfGroup(group.id)
  // Answering lists its categories one under the other: the realtime model, then the three stages.
  const categories = [...new Set(providers.map(p => providerSpec(p).category))]
  const note = groupNote(group, embedded)
  return (
    <section id={groupAnchor(group.id)} className="adm-provcat" aria-label={group.label}>
      {!embedded && (
        <h2>
          {group.label}
          <span className="adm-provcat-note">
            <StatusMark state={group.state} /> <StatusWords status={group} />
            {group.state === 'works' && group.providerLabel ? ` · ${group.providerLabel}` : ''}
          </span>
        </h2>
      )}
      {embedded && (
        <p className="adm-group-status">
          <StatusMark state={group.state} /> <StatusWords status={group} />
          {group.providerLabel ? ` · ${group.providerLabel}` : ''}
        </p>
      )}
      {note && <p className="help">{note}</p>}
      {group.id === 'answering' && group.state === 'missing' && (
        <div className="adm-onekey-card">
          <OneKey disabled={!data.canStoreKeys} onDone={onOneKey} />
        </div>
      )}
      {group.id === 'call-audio' ? (
        <CallAudio group={group} health={health} />
      ) : (
        categories.map(category => (
          <Fragment key={category}>
            {/* Answering: the two ways, one realtime model or three parts, each under its own heading. */}
            {group.id === 'answering' && answeringWays[category] && (
              <h3 className="adm-provway">{answeringWays[category]}</h3>
            )}
            <ProviderList
              title={
                categories.length > 1 && !(group.id === 'answering' && category === 'realtime')
                  ? providerCategories[category]
                  : null
              }
              category={category}
              providers={providers.filter(p => providerSpec(p).category === category)}
              data={data}
              lines={lines}
              onOpen={onOpen}
            />
          </Fragment>
        ))
      )}
    </section>
  )
}

function ProviderList({
  title,
  category,
  providers,
  data,
  lines,
  onOpen,
}: {
  title: string | null
  category: ProviderCategory
  providers: ProviderName[]
  data: AdminData
  lines: Record<ProviderName, ProviderLine>
  onOpen: (provider: ProviderName) => void
}) {
  const active = data.activeProviders[category]?.provider ?? null
  const setUp = providers.filter(p => lines[p]?.state !== 'missing')
  const [expanded, setExpanded] = useState(false)
  // Set up, being tested or failing: never folded away.
  const keep = (name: ProviderName) => {
    const status = data.providers.find(p => p.provider === name)
    return (!!status && isConfigured(status)) || (!!lines[name] && lines[name].state !== 'missing')
  }
  const list = visibleProviders(providers, { pinned: pinnedProvidersOf(category), keep, expanded })
  return (
    <>
      {title && <h3 className="adm-provsub">{title}</h3>}
      <ul className="adm-provlist">
        {list.shown.map(name => {
          const status = data.providers.find(p => p.provider === name)
          if (!status) return null
          const line = lines[name]
          const configured = isConfigured(status)
          // Which one is used, said only where it is a choice: several set up, or recording (off until picked).
          const use =
            configured && category !== 'sign_in' && (setUp.length > 1 || category === 'recording')
              ? active === name
                ? 'In use'
                : 'Not in use'
              : null
          return (
            <li key={name} className="adm-prov">
              <Logo mark={providerMeta[name].mark} size={28} />
              <span className="adm-prov-name">
                <b>{status.label}</b>
                {recommendedProviders[category] === name && <span className="adm-recommended">Recommended</span>}
                {configured && line && (
                  <span className="adm-tile-status">
                    <StatusMark state={line.state} /> <StatusWords status={line} />
                    {use ? ` · ${use}` : ''}
                    {providerState(status) === 'env' && <ServerSet />}
                  </span>
                )}
                {configured && line?.state === 'failing' && line.message && (
                  <span className="adm-prov-detail adm-prov-detail-danger">{line.message}</span>
                )}
              </span>
              <span className="adm-prov-actions">
                <Button
                  size="sm"
                  variant={configured ? 'ghost' : 'secondary'}
                  onClick={() => onOpen(name)}
                  title={configured ? `Edit ${status.label}` : `Connect ${status.label}`}
                >
                  {configured ? 'Edit' : 'Connect'}
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
          title={expanded ? 'Show only the recommended and the providers in use' : `Show ${list.hidden} more providers`}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  )
}

/** LiveKit and SIP as the server reports them, and how to set them up; nothing to edit here. */
function CallAudio({ group, health }: { group: GroupStatus; health: AdminHealth | null }) {
  const rows = [
    { label: 'LiveKit server', status: health?.livekit },
    { label: 'Phone calls (SIP)', status: health?.sip },
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
                />{' '}
                {row.status?.message ?? 'Checking…'}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {group.state !== 'works' && (
        <details className="adm-guide" open={group.state === 'missing'}>
          <summary>How to set it up</summary>
          <ol className="adm-guide-steps">
            {callAudioGuide.steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="help">
            <a href={callAudioGuide.url} target="_blank" rel="noreferrer">
              Ports and firewall
            </a>
            {' · '}
            {callAudioGuide.cost}
          </p>
        </details>
      )}
    </>
  )
}
