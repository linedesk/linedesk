// Server admin › Providers (LIN-158): every provider group in one place, in the same order and words as the overview's
// "Ready for calls" card and the install walkthrough (provider-status.ts): each group with its status, why it is
// there and its providers. Connect and Edit open the provider's dialog (ProviderDialog), the one editor. While a group
// calls need is not set up, the agent setup leads on top; once all are, the same note offers to change them.
// `#admin/providers/<group>` scrolls to the group, `#admin/providers/<provider>` opens its dialog; old category links
// (`#admin/providers/stt`) land on their group.
// "Show all providers" at the right of the heading opens every group's short list at once (and "Show fewer" folds
// them again); each list's own "Show more" still works, and the top button follows what the lists show.
import {
  type InstallSetupState,
  isMultiCategory,
  type ProviderName,
  providerCategoryLabel,
  type TranscriptProviderName,
} from '@linedesk/actions'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { openAgentSetup } from '../onboarding/AgentSetup.tsx'
import { type InstallSetupFrom, openInstallSetup } from '../onboarding/InstallSetup.tsx'
import { HelpTip } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { type AdminData, keyUsersOf, loadInstallSetup, runAdmin } from './api.ts'
import { isConfigured, selectsOnConnect } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { clearOpenRouterReturn, type OpenRouterReturn, peekOpenRouterReturn } from './openrouterAuth.ts'
import { ProviderDialog } from './ProviderDialog.tsx'
import { groupAnchor, type ListFolds, ProviderGroup } from './ProviderGroup.tsx'
import { allOpen, foldableLists, keepShown, listsOfGroup } from './providerList.ts'
import type { ProviderStatusState } from './providerStatus.ts'
import { providersTarget } from './route.ts'

/** Cache key of the install walkthrough's state (offered next to the agent while it is on and not finished). */
export const ADMIN_INSTALL_SETUP = 'admin.installSetup'

/**
 * The two ways to set up or change the install, always offered: "Set up with an AI agent" first (once everything is set
 * up, "Change with an AI agent": the agent setup page gives it a new link), and "Step by step", the install
 * walkthrough, next to it: "Step by step" always opens at its first part, "Continue step by step" (started, not
 * finished, not everything set up) where the admin left it; nothing saved is reset. On Cloud the walkthrough is off
 * (`enabled` false, it would only open Server admin › Providers), so only the agent is offered there. On top of Server
 * admin › Providers as a note; on the overview's card as a quiet line.
 */
export function AgentFirst({ lead, quiet, complete }: { lead: string; quiet?: boolean; complete?: boolean }) {
  const t = useT()
  const install = useQuery(ADMIN_INSTALL_SETUP, () => loadInstallSetup()).data
  const label = agentFirstLabels(install, complete)
  const buttons = (
    <>
      <Button
        size="sm"
        variant="primary"
        icon="spark"
        onClick={openAgentSetup}
        title={complete ? t('admin.providers.agent.changeTip') : t('admin.providers.agent.setUpTip')}
      >
        {label.agent}
      </Button>
      {label.steps && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openInstallSetup({ from: label.stepsFrom })}
          title={t('admin.providers.agent.stepsTip')}
        >
          {label.steps}
        </Button>
      )}
    </>
  )
  if (quiet)
    return (
      <div className="adm-agent-line">
        <span className="help">{lead}</span>
        {buttons}
      </div>
    )
  return (
    <Note tone="info" action={buttons}>
      {lead}
    </Note>
  )
}

/**
 * AgentFirst's buttons: the agent's ("Change …" once everything is set up) and the walkthrough's, or none for the
 * walkthrough while its state is not read yet or it is off (Cloud). "Continue step by step" resumes where the admin
 * left the walkthrough; "Step by step" opens it at its first part.
 */
export function agentFirstLabels(
  install: Pick<InstallSetupState, 'enabled' | 'progress'> | undefined,
  complete = false,
): { agent: string; steps: string | null; stepsFrom: InstallSetupFrom } {
  const { t } = i18n()
  const agent = complete ? t('admin.providers.agent.change') : t('admin.providers.agent.setUp')
  if (!install?.enabled) return { agent, steps: null, stepsFrom: 'start' }
  const started = install.progress.step !== 'welcome' && !install.progress.finishedAt
  return !complete && started
    ? { agent, steps: t('admin.providers.agent.stepsContinue'), stepsFrom: 'left' }
    : { agent, steps: t('admin.providers.agent.steps'), stepsFrom: 'start' }
}

type DialogForProps = {
  name: ProviderName
  data: AdminData
  status: ProviderStatusState
  oauthReturn?: OpenRouterReturn | null
  reload: () => Promise<void>
  notify: Notify
  onClose: () => void
}

/** The provider's dialog with everything it needs from the admin data: the same on every screen. */
export function ProviderDialogFor({ name, data, status, oauthReturn, reload, notify, onClose }: DialogForProps) {
  const t = useT()
  const opened = data.providers.find(p => p.provider === name)
  const line = status.status?.lines[name]
  if (!opened || !line) return null
  const { category } = opened
  const active = data.activeProviders[category]

  async function use(provider: ProviderName | null) {
    const before = active.chosen ? active.provider : null
    const set = async (next: ProviderName | null) => {
      // After-call transcription has its own action (it uploads recordings; audited as an admin change).
      if (category === 'transcript')
        await runAdmin('afterCallTranscript.set', { provider: next as TranscriptProviderName | null })
      else await runAdmin('provider.setActive', { category, provider: next })
      await reload()
    }
    try {
      await set(provider)
      notify(
        provider
          ? t('admin.providers.use.now', { category: providerCategoryLabel(category, i18n()), provider: opened!.label })
          : category === 'recording'
            ? t('admin.providers.use.recordingOff')
            : category === 'transcript'
              ? t('admin.providers.use.transcriptOff')
              : t('admin.providers.use.default', { category: providerCategoryLabel(category, i18n()) }),
        () => set(before),
      )
    } catch (err) {
      notify(errorText(err))
    }
  }

  return (
    <ProviderDialog
      key={opened.provider}
      provider={opened}
      line={line}
      inUse={isMultiCategory(category) ? isConfigured(opened) : active.provider === opened.provider}
      chosen={active.chosen}
      canUse={
        !isMultiCategory(category) &&
        (data.providers.filter(p => p.category === category).length > 1 || selectsOnConnect(category))
      }
      canStore={data.canStoreKeys}
      keyUsers={keyUsersOf(data.providers, opened.provider)}
      oauthReturn={oauthReturn ?? null}
      onTested={(result, stored) => status.record(opened.provider, result, { stored })}
      onUse={() => use(opened.provider)}
      onStopUsing={() => use(null)}
      reload={reload}
      notify={notify}
      onClose={onClose}
    />
  )
}

type Props = {
  data: AdminData
  status: ProviderStatusState
  /** `#admin/providers/<id>`: a group or a provider. */
  id: string | null
  /** Back to `#admin/providers` once a provider opened by its link is closed. */
  onClearId: () => void
  notify: Notify
  reload: () => Promise<void>
  /** The place right of the page's heading, for "Show all providers". */
  headActions?: HTMLElement | null
}

/** "Show all providers" / "Show fewer": every group's short list at once. */
function ShowAll({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT()
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-expanded={open}
      onClick={onToggle}
      title={open ? t('admin.providers.showAll.fewerTip') : t('admin.providers.showAll.allTip')}
    >
      {open ? t('admin.providers.showAll.fewer') : t('admin.providers.showAll.all')}
    </Button>
  )
}

export function Providers({ data, status, id, onClearId, notify, reload, headActions }: Props) {
  const t = useT()
  const format = useFormat()
  const target = providersTarget(id)
  // Back from "Connect with OpenRouter": its dialog opens and finishes the connection.
  const [oauthReturn] = useState<OpenRouterReturn | null>(() => peekOpenRouterReturn())
  useEffect(clearOpenRouterReturn, [])
  const [open, setOpen] = useState<ProviderName | null>(oauthReturn ? 'openrouter' : null)
  const linked = target && 'provider' in target ? target.provider : null
  useEffect(() => {
    if (linked) setOpen(linked)
  }, [linked])
  const group = target && 'group' in target ? target.group : null
  useEffect(() => {
    if (group) document.getElementById(groupAnchor(group))?.scrollIntoView({ block: 'start' })
  }, [group])

  const groups = status.status?.groups ?? []
  const missing = groups.filter(g => g.needed && g.state === 'missing')

  // Which provider lists are open: held here, so one button opens or folds them all.
  const [openLists, setOpenLists] = useState<ReadonlySet<string>>(() => new Set())
  const lines = status.status?.lines
  const lists = groups.flatMap(g => listsOfGroup(g.id))
  const foldable = lines ? foldableLists(lists, keepShown(data, lines), openLists) : []
  const everyOpen = allOpen(foldable, openLists)
  const folds: ListFolds = {
    isOpen: key => openLists.has(key),
    setOpen: (key, open) =>
      setOpenLists(prev => {
        const next = new Set(prev)
        if (open) next.add(key)
        else next.delete(key)
        return next
      }),
  }
  const close = () => {
    setOpen(null)
    if (linked) onClearId()
  }

  return (
    <>
      {headActions &&
        foldable.length > 0 &&
        createPortal(
          <ShowAll open={everyOpen} onToggle={() => setOpenLists(everyOpen ? new Set() : new Set(foldable))} />,
          headActions,
        )}
      {!data.canStoreKeys && (
        <Note tone="warning">
          {t('admin.providers.noSecretsKey')}{' '}
          <HelpTip text={t('admin.providers.noSecretsKeyHelp', { command: 'openssl rand -base64 32' })} />
        </Note>
      )}
      {status.status &&
        (missing.length > 0 ? (
          <AgentFirst
            lead={t('admin.providers.missingLead', {
              groups: format.list(missing.map(g => g.label)),
              count: missing.length,
            })}
          />
        ) : (
          <AgentFirst lead={t('admin.providers.allSetLead')} complete />
        ))}
      {status.status &&
        groups.map(g => (
          <ProviderGroup
            key={g.id}
            group={g}
            data={data}
            lines={status.status!.lines}
            health={status.health}
            onOpen={setOpen}
            onOneKey={async () => {
              await reload()
              notify(t('admin.providers.oneKeyDone'))
            }}
            onPipelinePolicy={reload}
            folds={folds}
          />
        ))}
      {open && (
        <ProviderDialogFor
          name={open}
          data={data}
          status={status}
          oauthReturn={open === 'openrouter' ? oauthReturn : null}
          reload={reload}
          notify={notify}
          onClose={close}
        />
      )}
    </>
  )
}
