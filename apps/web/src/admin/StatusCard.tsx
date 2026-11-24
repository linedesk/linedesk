// Server admin › Overview, on top: "Ready for calls" (LIN-158). One read-only summary in the words of Server admin ›
// Providers: a calm line with the mark and the headline, and the details below it: the groups a call needs (and an
// optional group only while it fails), then the server's own parts (API, read sync, voice agent) under System. Each
// part is a row of the app's list (ui/list.tsx) that opens where it is fixed; nothing is edited or tested here. The
// same status rule as Providers: a part that works shows only its mark (the words are its tooltip) and what is in use,
// muted; words only for a problem. The details fold away once everything works; a failing group a call needs makes the
// headline "Calls are not answered" with the reason. The install walkthrough shows the same rows (StatusList) without
// links: it never navigates away (design rule 14). A part whose fix is clear says the consequence and offers the fix
// in its row (LIN-773): a provider that rejects its key gets "Replace key", which opens the key field in place (the
// provider dialog's form and its save + recheck); the voice agent that is not running gets the command that starts it.
import {
  type GroupStatus,
  overviewGroups,
  type ProviderName,
  readiness,
  type StatusState,
  statusText,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { refreshQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { ExternalLink } from '../ui/AppLink.tsx'
import { HelpTip, onSaveKey } from '../ui/form.tsx'
import { copyText } from '../ui/HelpTip.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { ADMIN_HEALTH, type AdminHealth, type AdminProviders, type HealthPart, type ProviderStatus } from './api.ts'
import { changedValues, fieldErrors, initialValues } from './model.ts'
import type { Notify } from './notify.ts'
import { errorText } from './notify.ts'
import { stepUpRefusalText } from './PasskeyStepUp.tsx'
import { KeyGuide, ProviderForm, storeAndTest } from './ProviderDialog.tsx'
import { providerMeta } from './ProviderLogo.tsx'
import { AgentFirst } from './Providers.tsx'
import {
  groupProblem,
  groupTrouble,
  groupValue,
  type ProviderStatusState,
  providerErrorLine,
  replacesKey,
  troubleHeadline,
  troubleLine,
} from './providerStatus.ts'

/**
 * One part: its mark (with `mark` as tooltip), its name, a short muted value at the right (what is in use, or "Not set
 * up"), and for a problem a sentence under the name (`problem`, it wraps) with the detail behind a (?) (`help`).
 */
export type Row = {
  id: string
  label: string
  /** null: a part with no state of its own (Billing › Prices and rules); the row keeps the mark's place empty. */
  state: StatusState | null
  mark: string
  value: string | null
  problem: string | null
  help: string | null
  href: string
  /** The provider whose key to replace in place (it rejects the one it has). */
  replaceKey?: { provider: ProviderName; label: string } | null
  /** A command that fixes it, shown after the problem with a Copy button. */
  command?: string | null
  /** A page in the docs that says how to fix it, after the problem. */
  docs?: string | null
}

/** The docs on running the voice agent yourself (outside Docker Compose): the Agent service of the deploy methods. */
export const AGENT_DOCS_URL = 'https://github.com/linedesk/linedesk/blob/HEAD/docs/self-hosting.md#deploy-methods'
/** What starts the voice agent, per install (docs/self-hosting.md, docs/commands.md). Commands, not text to translate. */
export const AGENT_START_DOCKER = 'docker compose up -d agent'
export const AGENT_START_DEV = 'pnpm --filter @linedesk/agent worker'

/** The voice agent that is not running: what to do on this install, with the command or the docs. */
export function agentStart(
  installType: AdminHealth['installType'],
  message: string,
): Pick<Row, 'problem' | 'help' | 'command' | 'docs'> {
  const { t } = i18n()
  // Linedesk Cloud runs the same compose stack as a self-hosted server.
  if (installType === 'docker' || installType === 'cloud')
    return {
      problem: t('admin.status.agent.startDocker'),
      command: AGENT_START_DOCKER,
      help: `${message} ${t('admin.status.agent.voiceServers')}`,
      docs: null,
    }
  if (installType === 'dev')
    return { problem: t('admin.status.agent.startDev'), command: AGENT_START_DEV, help: message, docs: null }
  return { problem: t('admin.status.agent.startOther'), command: null, help: message, docs: AGENT_DOCS_URL }
}

const serverParts: { key: HealthPart; label: MessageKey }[] = [
  { key: 'api', label: msg('admin.status.part.api') },
  { key: 'readSync', label: msg('admin.status.part.readSync') },
  { key: 'agent', label: msg('admin.status.part.agent') },
]

/** What a working server part says beyond its mark: only the voice agent's last check-in is worth a line. */
const quietWhenOk: readonly HealthPart[] = ['api', 'readSync']

export const groupRow = (g: GroupStatus): Row => {
  // A provider that fails: named, with what it stops; its full text and fix behind the (?).
  const trouble = groupTrouble(g)
  if (trouble)
    return {
      id: g.id,
      label: g.label,
      state: g.state,
      mark: statusText(g, i18n()),
      value: null,
      problem: troubleLine(g, trouble),
      help: g.message?.trim() || null,
      href: `#admin/providers/${g.id}`,
      replaceKey: replacesKey(trouble) ? { provider: trouble.provider, label: trouble.label } : null,
    }
  const problem = groupProblem(g)
  return {
    id: g.id,
    label: g.label,
    state: g.state,
    mark: statusText(g, i18n()),
    // A problem is said under the name, in full; the right side stays short.
    value: problem ? null : groupValue(g),
    problem: problem?.line ?? null,
    help: problem?.detail ?? null,
    href: `#admin/providers/${g.id}`,
  }
}

/** The server's own parts, as the health check reports them. */
export const serverRows = (health: AdminHealth | null): Row[] =>
  serverParts.map(({ key, label }) => {
    const { t } = i18n()
    const status = health?.[key]
    const state: StatusState = !status ? 'checking' : status.ok ? 'works' : 'failing'
    const failing = status && !status.ok
    if (failing && key === 'agent')
      return {
        id: key,
        label: t(label),
        state,
        mark: t('admin.status.failing'),
        value: null,
        href: '#admin/providers/call-audio',
        ...agentStart(health?.installType, status.message),
      }
    return {
      id: key,
      label: t(label),
      state,
      // The status word once in the mark; the error once, short, under the name, its full text behind the (?).
      mark: !status
        ? t('admin.providers.checking')
        : status.ok
          ? t('admin.status.responding')
          : t('admin.status.failing'),
      value: failing || (status?.ok && quietWhenOk.includes(key)) ? null : (status?.message ?? null),
      problem: failing ? providerErrorLine(status.message) : null,
      help: failing && providerErrorLine(status.message) !== status.message.trim() ? status.message : null,
      href: '#admin/providers/call-audio',
    }
  })

/** What Replace key needs: the providers' keys, and the dialog's way to record the recheck and reload. */
export type KeyFixes = {
  providers: AdminProviders | null
  record: ProviderStatusState['record']
  reload: () => Promise<void>
  notify: Notify
}

/** A command to run, in the row's text, with a Copy button that says "Copied" for a moment. */
function Command({ code }: { code: string }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <span className="adm-cmd">
      <code>{code}</code>
      <Button
        size="sm"
        variant="ghost"
        icon={state === 'copied' ? 'check' : 'copy'}
        className="adm-cmd-copy"
        onClick={() => void copyText(code).then(setState)}
        title={state === 'failed' ? t('common.copy.selectIt') : t('common.copy.copy')}
        aria-label={state === 'copied' ? t('common.copy.copied') : t('common.copy.copyThis', { text: code })}
      />
    </span>
  )
}

/** One part as a row of the list; with `link` the whole row opens `href` (Overview, Billing). */
export function StatusRow({ row, link, keys }: { row: Row; link: boolean; keys?: KeyFixes }) {
  const t = useT()
  const [replacing, setReplacing] = useState(false)
  const bad = row.state === 'failing'
  const provider = row.replaceKey && keys?.providers?.providers.find(p => p.provider === row.replaceKey!.provider)
  // The fix in place: only where the key can be stored here and the provider has one to replace.
  const canReplace = !!provider && !!keys?.providers?.canStoreKeys && provider.fields.some(f => f.secret)
  const linked = link && !canReplace
  return (
    <ListRow
      className={cx('adm-status-row', linked && 'adm-status-row-link')}
      lead={
        row.state ? (
          <StatusMark state={row.state} label={row.mark} />
        ) : (
          <span className="adm-status-nomark" aria-hidden />
        )
      }
      sub={
        row.problem ? (
          <span className={cx('adm-status-problem', bad && 'adm-status-bad')}>
            {row.problem}
            {row.command && (
              <>
                {' '}
                <Command code={row.command} />
              </>
            )}
            {row.docs && (
              <>
                {' '}
                <ExternalLink href={row.docs}>{t('admin.status.agent.docs')}</ExternalLink>
              </>
            )}
            {row.help && <HelpTip text={row.help} />}
          </span>
        ) : null
      }
      title={
        linked ? (
          <a className="adm-status-link" href={row.href} title={t('admin.status.openTip', { part: row.label })}>
            {row.label}
          </a>
        ) : (
          row.label
        )
      }
      aside={
        row.value ? (
          <span className={cx('adm-status-value', bad && 'adm-status-bad')} title={row.value}>
            {row.value}
          </span>
        ) : null
      }
      actions={
        canReplace && !replacing ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => setReplacing(true)}
            title={t('admin.status.replaceKeyTip', { provider: row.replaceKey!.label })}
          >
            {t('admin.status.replaceKey')}
          </Button>
        ) : linked ? (
          <Icon name="left" size={13} className="adm-status-chevron" />
        ) : null
      }
      below={
        canReplace && replacing && keys ? (
          <ReplaceKey provider={provider!} keys={keys} onClose={() => setReplacing(false)} />
        ) : null
      }
    />
  )
}

/**
 * Replace key, in the row: the provider dialog's form with only its secret fields, saved and rechecked the dialog's
 * way (storeAndTest). The recheck is recorded before the reload, so the row turns green in the next frame when the new
 * key works (design rule 13); when it does not, the form stays with the provider's answer under the field.
 */
function ReplaceKey({ provider, keys, onClose }: { provider: ProviderStatus; keys: KeyFixes; onClose: () => void }) {
  const t = useT()
  const secrets = useMemo(() => ({ ...provider, fields: provider.fields.filter(f => f.secret) }), [provider])
  const [values, setValues] = useState(() => initialValues(secrets))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle')
  const busy = phase !== 'idle'
  const changes = changedValues(secrets, values)
  const dirty = Object.keys(changes).length > 0
  const first = secrets.fields[0]!.field
  const fieldId = (field: string) => `replace-${provider.provider}-${field}`

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !dirty) return
    const problems = fieldErrors(secrets, values)
    setErrors(problems)
    if (Object.keys(problems).length) return
    try {
      const tested = await storeAndTest(provider.provider, changes, setPhase)
      keys.record(provider.provider, tested, { stored: true })
      await keys.reload()
      if (tested.ok) {
        keys.notify(t('admin.status.keyReplaced', { provider: provider.label }))
        return onClose()
      }
      setValues(initialValues(secrets))
      setErrors({ [first]: providerErrorLine(tested.message) })
    } catch (err) {
      setErrors({ [first]: stepUpRefusalText(err) ?? errorText(err) })
    }
    setPhase('idle')
  }

  return (
    <form
      className="adm-replace-key"
      onSubmit={save}
      onKeyDown={e => {
        onSaveKey(e, dirty && !busy)
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <ProviderForm
        provider={secrets}
        values={values}
        errors={errors}
        canStore
        busy={busy}
        // Not "configured" for the form: the new key's field takes the focus as it opens.
        configured={false}
        manual
        oauthDone={false}
        preset={null}
        keysUrl={providerMeta[provider.provider].keysUrl}
        keyField={first}
        redirects={[]}
        fieldId={fieldId}
        onManual={() => {}}
        onPreset={() => {}}
        onChange={(field, value) => {
          setValues(v => ({ ...v, [field]: value }))
          setErrors(({ [field]: _, ...rest }) => rest)
        }}
        compact
      />
      <div className="adm-replace-key-actions">
        <KeyGuide provider={secrets} open={false} />
        <Button variant="ghost" onClick={onClose} disabled={busy} title={t('common.action.cancel')}>
          {t('common.action.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={busy || !dirty}
          title={t('admin.providerDialog.saveTip', { key: '⌘S' })}
        >
          {phase === 'testing'
            ? t('admin.providerDialog.testing')
            : busy
              ? t('common.action.saving')
              : t('common.action.save')}
        </Button>
      </div>
    </form>
  )
}

/** The rows: the groups a call needs (and optional ones while they fail), then the server's parts under System. */
export function StatusList({
  groups,
  health,
  links = true,
  keys,
}: {
  groups: readonly GroupStatus[]
  /** The server's parts: on the overview only. */
  health?: AdminHealth | null
  links?: boolean
  /** Replace key in place: on the overview only. */
  keys?: KeyFixes
}) {
  const t = useT()
  const parts = overviewGroups(groups).map(groupRow)
  const server = health !== undefined ? serverRows(health) : null
  return (
    <div className="adm-health" aria-live="polite">
      {server && <h3 className="adm-health-sub">{t('admin.status.providers')}</h3>}
      <List label={t('admin.status.providers')}>
        {parts.map(row => (
          <StatusRow key={row.id} row={row} link={links} keys={keys} />
        ))}
      </List>
      {server && (
        <>
          <h3 className="adm-health-sub">{t('admin.status.system')}</h3>
          <List label={t('admin.status.system')}>
            {server.map(row => (
              <StatusRow key={row.id} row={row} link={links} />
            ))}
          </List>
        </>
      )}
    </div>
  )
}

/** The card's state at a glance: the headline's mark. */
const headlineMark = (state: ReturnType<typeof readiness>['state'], serverDown: boolean): StatusState =>
  state === 'blocked' || state === 'failing' || serverDown
    ? 'failing'
    : state === 'ready'
      ? 'works'
      : state === 'checking'
        ? 'checking'
        : 'missing'

export function StatusCard({ status, keys }: { status: ProviderStatusState; keys?: KeyFixes }) {
  const t = useT()
  const [open, setOpen] = useState<boolean | null>(null)
  if (!status.status) return <Skeleton className="adm-card adm-skel-card" />
  const { groups } = status.status
  const ready = readiness(groups, i18n())
  const server = serverRows(status.health)
  const serverDown = server.find(r => r.state === 'failing')
  const allGood = ready.state === 'ready' && !serverDown && server.every(r => r.state === 'works')
  const expanded = open ?? !allGood
  const notSetUp = groups.some(g => g.needed && g.state === 'missing')
  const headline =
    serverDown && ready.state === 'ready' ? t('admin.status.partFailing', { part: serverDown.label }) : ready.headline
  const mark = headlineMark(ready.state, !!serverDown)
  // A failing provider is named with what is wrong ("OpenRouter's API key was rejected."), not as "group: status".
  // A group without a provider to name (call audio) says its problem the row's way, not "Call audio: Failing: …".
  const trouble = ready.group ? groupTrouble(ready.group) : null
  const said = trouble ? troubleHeadline(trouble) : ready.group ? (groupProblem(ready.group)?.line ?? null) : null
  const line = allGood
    ? t('admin.status.allGood')
    : (said ??
      ready.reason ??
      (serverDown ? t('admin.status.partProblem', { part: serverDown.label, problem: serverDown.problem }) : null))
  return (
    <section className="adm-card adm-ready" aria-label={t('admin.status.readyLabel')}>
      <div className="adm-ready-head">
        <StatusMark state={mark} label={headline} />
        <div className="adm-ready-text">
          <h2 className={ready.state === 'blocked' ? 'adm-status-bad' : undefined}>{headline}</h2>
          {line && <p className="help">{line}</p>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refreshQuery(ADMIN_HEALTH)}
          title={t('admin.status.checkAgainTip')}
        >
          {t('admin.status.checkAgain')}
        </Button>
      </div>
      <button
        type="button"
        className="adm-ready-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        title={expanded ? t('admin.status.details.hideTip') : t('admin.status.details.showTip')}
      >
        <Icon name="down" size={12} />
        {expanded ? t('admin.status.details.hide') : t('admin.status.details.show')}
      </button>
      {expanded && <StatusList groups={groups} health={status.health} keys={keys} />}
      {notSetUp ? (
        <AgentFirst lead={t('admin.status.agentNotSetUpLead')} quiet />
      ) : (
        <AgentFirst lead={t('admin.status.agentAllSetLead')} quiet complete />
      )}
    </section>
  )
}
