// Admin › Providers (LIN-158): every provider group in one place, in the same order and words as the overview's
// "Ready for calls" card and the install walkthrough (provider-status.ts): each group with its status, why it is
// there and its providers. Connect and Edit open the provider's dialog (ProviderDialog), the one editor. While a group
// calls need is not set up, the agent setup leads on top. `#admin/providers/<group>` scrolls to the group,
// `#admin/providers/<provider>` opens its dialog; old category links (`#admin/providers/stt`) land on their group.
import { isMultiCategory, listWords, providerCategories, type ProviderName } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { openAgentSetup } from '../onboarding/AgentSetup.tsx'
import { openInstallSetup } from '../onboarding/InstallSetup.tsx'
import { HelpTip } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { type AdminData, keyUsersOf, loadInstallSetup, runAdmin } from './api.ts'
import { isConfigured } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { clearOpenRouterReturn, type OpenRouterReturn, peekOpenRouterReturn } from './openrouterAuth.ts'
import { ProviderDialog } from './ProviderDialog.tsx'
import { groupAnchor, ProviderGroup } from './ProviderGroup.tsx'
import { providersTarget } from './route.ts'
import type { ProviderStatusState } from './providerStatus.ts'

/** Cache key of the install walkthrough's state (offered next to the agent while it is on and not finished). */
export const ADMIN_INSTALL_SETUP = 'admin.installSetup'

/**
 * "Set up with an AI agent", the first way to set up an install, and "Step by step" next to it while the walkthrough
 * is on. On top of Admin › Providers as a note; on the overview's card as a quiet line.
 */
export function AgentFirst({ lead, quiet }: { lead: string; quiet?: boolean }) {
  const install = useQuery(ADMIN_INSTALL_SETUP, () => loadInstallSetup()).data
  const buttons = (
    <>
      <Button
        size="sm"
        variant="primary"
        icon="spark"
        onClick={openAgentSetup}
        title="Let Claude, ChatGPT or another AI agent set up this install with you"
      >
        Set up with an AI agent
      </Button>
      {install?.enabled && (
        <Button
          size="sm"
          variant="ghost"
          onClick={openInstallSetup}
          title="Go through each group yourself, one screen at a time, with a real test for each"
        >
          {install.progress.step !== 'welcome' && !install.progress.finishedAt
            ? 'Continue step by step'
            : 'Step by step'}
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
  const opened = data.providers.find(p => p.provider === name)
  const line = status.status?.lines[name]
  if (!opened || !line) return null
  const { category } = opened
  const active = data.activeProviders[category]

  async function use(provider: ProviderName | null) {
    const before = active.chosen ? active.provider : null
    const set = async (next: ProviderName | null) => {
      await runAdmin('provider.setActive', { category, provider: next })
      await reload()
    }
    try {
      await set(provider)
      notify(
        provider
          ? `${providerCategories[category]} uses ${opened!.label} now.`
          : category === 'recording'
            ? 'Calls are not recorded now.'
            : `${providerCategories[category]} uses the default now.`,
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
        (data.providers.filter(p => p.category === category).length > 1 || category === 'recording')
      }
      canStore={data.canStoreKeys}
      keyUsers={keyUsersOf(data.providers, opened.provider)}
      oauthReturn={oauthReturn ?? null}
      onTested={result => status.record(opened.provider, result)}
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
}

export function Providers({ data, status, id, onClearId, notify, reload }: Props) {
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
  const close = () => {
    setOpen(null)
    if (linked) onClearId()
  }

  return (
    <>
      {!data.canStoreKeys && (
        <Note tone="warning">
          No encryption key on the server, so keys can't be saved.{' '}
          <HelpTip text="Whoever runs the server sets SECRETS_KEY (make one with openssl rand -base64 32) and restarts the API. Keys are then saved encrypted." />
        </Note>
      )}
      {missing.length > 0 && (
        <AgentFirst
          lead={`${listWords(missing.map(g => g.label))} ${missing.length > 1 ? 'are' : 'is'} not set up yet. An AI agent can set up the rest with you in about 15 minutes.`}
        />
      )}
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
              notify('Calls are answered with OpenAI now.')
            }}
            onPipelinePolicy={reload}
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
