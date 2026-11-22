// Workspaces: a searchable list; a click opens the workspace with its facts and actions. Two more views of the same
// workspaces (LIN-747, the Onboarding and Usage sections before): the ones at risk, and usage by month.
import { useT } from '@linedesk/i18n/react'
import { type MessageKey, msg } from '@linedesk/i18n'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { fmt } from '../i18n/format.ts'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { ActionBar, RowActions, signInAsOwnerAction, useActionRunner, workspaceActions } from './actions.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { type AdminUser, type AdminWorkspace, runAdmin } from './api.ts'
import { WorkspaceMembersCard } from './Memberships.tsx'
import { formatMinutes, formatUsd, parseSpendingCap } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { day, EMPTY, when } from './parts.tsx'
import { formatNumber } from '../onboarding/flow.ts'
import { WORKSPACE_VIEWS, type WorkspaceView, workspaceViewOfHash, workspacesHref } from './route.ts'
import { NewWorkspaceDialog } from '../shell/NewWorkspace.tsx'

type Translate = ReturnType<typeof useT>

const workspaceColumns = (t: Translate): Column<AdminWorkspace>[] => [
  {
    key: 'name',
    label: t('admin.workspaces.column.workspace'),
    sort: w => w.name,
    render: w => (
      <span className="adm-strong">
        {w.name}
        {w.disabled_at && <Badge>{t('admin.workspaces.badge.disabled')}</Badge>}
      </span>
    ),
  },
  {
    key: 'numbers',
    label: t('admin.workspaces.column.number'),
    wide: true,
    render: w => (
      <span className="adm-mono">
        {w.phone_numbers[0] ? formatNumber(w.phone_numbers[0]) : EMPTY}
        {w.phone_numbers.length > 1 && ` ${t('admin.workspaces.moreNumbers', { count: w.phone_numbers.length - 1 })}`}
      </span>
    ),
  },
  {
    key: 'calls',
    label: t('admin.workspaces.column.calls30d'),
    numeric: true,
    firstDir: 'desc',
    sort: w => w.calls_30d,
    render: w => fmt().number(w.calls_30d),
  },
  {
    key: 'last',
    label: t('admin.workspaces.column.lastCall'),
    firstDir: 'desc',
    wide: true,
    sort: w => (w.last_call_at ? Date.parse(w.last_call_at) : null),
    render: w => when(w.last_call_at),
  },
]

type ListProps = {
  workspaces: AdminWorkspace[]
  onOpen: (id: string) => void
  keysRef: { current: ListKeys | null }
  notify: Notify
  reload: () => Promise<void>
  /** The workspaces the signed-in admin is a member of (a delete then counts them out of the other members). */
  viewerWorkspaces: ReadonlySet<string>
  /** The views of Workspaces, beside New workspace. */
  views?: React.ReactNode
}

/** Server admin › Workspaces › New workspace: the app's one dialog, here with the owner by email offered as well. */
function NewWorkspaceButton({ notify, reload }: { notify: Notify; reload: () => Promise<void> }) {
  const t = useT()
  const [shown, setShown] = useState(false)
  return (
    <>
      <div>
        <Button size="sm" icon="plus" title={t('shell.newWorkspace.openTip')} onClick={() => setShown(true)}>
          {t('shell.newWorkspace.open')}
        </Button>
      </div>
      {shown && (
        <NewWorkspaceDialog
          ownerChoice
          onClose={() => setShown(false)}
          onCreatedForOwner={async text => {
            // The list shows it before the dialog closes.
            await reload()
            notify(text)
          }}
        />
      )}
    </>
  )
}

const VIEW_LABELS: Record<WorkspaceView, MessageKey> = {
  all: msg('admin.workspaces.view.all'),
  'at-risk': msg('admin.workspaces.view.atRisk'),
  usage: msg('admin.workspaces.view.usage'),
}

/** The view the address asks for (`#admin/workspaces?view=`); a pick replaces the address, so reload keeps it. */
export function useWorkspaceView() {
  const [view, setView] = useState(() => workspaceViewOfHash(window.location.hash))
  useEffect(() => {
    const onHash = () => setView(workspaceViewOfHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const choose = (next: WorkspaceView) => {
    setView(next)
    window.history.replaceState(window.history.state, '', workspacesHref(next))
  }
  return [view, choose] as const
}

/** The views of Workspaces, as the chips of Billing's bills: All, At risk, Usage by month. */
export function WorkspaceViews({ view, onPick }: { view: WorkspaceView; onPick: (view: WorkspaceView) => void }) {
  const t = useT()
  return (
    <div className="adm-chips" role="group" aria-label={t('admin.workspaces.view.label')}>
      {WORKSPACE_VIEWS.map(value => (
        <button
          key={value}
          type="button"
          className="adm-chip"
          aria-pressed={view === value}
          onClick={() => onPick(value)}
        >
          {t(VIEW_LABELS[value])}
        </button>
      ))}
    </div>
  )
}

export function WorkspacesList({ workspaces, onOpen, keysRef, notify, reload, viewerWorkspaces, views }: ListProps) {
  const runner = useActionRunner(notify)
  const t = useT()
  const columns = useMemo(() => workspaceColumns(t), [t])
  return (
    <>
      <div className="adm-views-row">
        {views}
        <NewWorkspaceButton notify={notify} reload={reload} />
      </div>
      <AdminList
        rows={workspaces}
        rowId={w => w.id}
        columns={columns}
        initialSort={{ key: 'name', dir: 'asc' }}
        searchText={w => `${w.name} ${w.phone_numbers.join(' ')}`}
        searchLabel={t('admin.workspaces.search')}
        label={t('admin.sections.workspaces.label')}
        onOpen={w => onOpen(w.id)}
        keysRef={keysRef}
        empty={t('admin.workspaces.empty')}
        rowActions={w => (
          <RowActions
            actions={workspaceActions(w, reload, { viewerIsMember: viewerWorkspaces.has(w.id) })}
            onPick={runner.pick}
          />
        )}
      />
      {runner.dialog}
    </>
  )
}

type DetailProps = {
  workspace: AdminWorkspace
  users: AdminUser[]
  notify: Notify
  reload: () => Promise<void>
  /** Back to the list, once the workspace is deleted. */
  onDeleted: () => void
  viewerWorkspaces: ReadonlySet<string>
  /** The signed-in admin: signing in as an owner who is you is refused. */
  currentUserId: string
}

export function WorkspaceDetail({
  workspace: w,
  users,
  notify,
  reload,
  onDeleted,
  viewerWorkspaces,
  currentUserId,
}: DetailProps) {
  const runner = useActionRunner(notify)
  const t = useT()
  const signInAsOwner = signInAsOwnerAction(w, users, currentUserId)
  return (
    <>
      <ActionBar
        actions={[
          ...(signInAsOwner ? [signInAsOwner] : []),
          ...workspaceActions(w, reload, { onDeleted, viewerIsMember: viewerWorkspaces.has(w.id) }),
        ]}
        onPick={runner.pick}
      />
      <Card title={t('admin.workspaces.details')} className="adm-detail">
        <dl className="adm-facts">
          <Fact label={t('admin.workspaces.fact.status')}>
            {w.disabled_at
              ? t('admin.workspaces.fact.disabledAt', { when: when(w.disabled_at) })
              : t('admin.workspaces.fact.active')}
          </Fact>
          <Fact label={t('admin.workspaces.fact.phoneNumbers')}>
            <span className="adm-mono">
              {w.phone_numbers.length
                ? fmt().list(w.phone_numbers.map(formatNumber), { type: 'unit', style: 'short' })
                : t('admin.workspaces.fact.noNumbers')}
            </span>
          </Fact>
          <Fact label={t('admin.workspaces.fact.calls30d')}>{fmt().number(w.calls_30d)}</Fact>
          <Fact label={t('admin.workspaces.fact.answeredMonth')}>{formatMinutes(w.minutes_this_month)}</Fact>
          <Fact label={t('admin.workspaces.fact.costMonth')}>{formatUsd(w.cost_this_month)}</Fact>
          <Fact label={t('admin.workspaces.fact.lastCall')}>{when(w.last_call_at)}</Fact>
          <Fact label={t('admin.workspaces.fact.partner')}>
            {w.partner_name ?? t('admin.workspaces.fact.noPartner')}
          </Fact>
          <Fact label={t('admin.workspaces.fact.created')}>{day(w.created_at)}</Fact>
        </dl>
      </Card>
      <SpendingCapCard workspace={w} notify={notify} reload={reload} />
      <WorkspaceMembersCard workspace={w} users={users} notify={notify} reload={reload} />
      {runner.dialog}
    </>
  )
}

/** The workspace's monthly spending cap: empty is no cap. Instance admins only (the whole admin area is). */
function SpendingCapCard({
  workspace: w,
  notify,
  reload,
}: {
  workspace: AdminWorkspace
  notify: Notify
  reload: () => Promise<void>
}) {
  const t = useT()
  const saved = w.spending_cap_usd === null ? '' : String(w.spending_cap_usd)
  const [text, setText] = useState(saved)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => setText(saved), [saved])
  const reached = w.spending_cap_usd !== null && w.cost_this_month >= w.spending_cap_usd
  async function save(e: FormEvent) {
    e.preventDefault()
    const parsed = parseSpendingCap(text)
    if ('problem' in parsed) return setProblem(parsed.problem)
    setProblem(null)
    setSaving(true)
    try {
      await runAdmin('workspace.setSpendingCap', { workspaceId: w.id, capUsd: parsed.capUsd })
      await reload()
      notify(
        parsed.capUsd === null
          ? t('admin.workspaces.cap.none', { name: w.name })
          : t('admin.workspaces.cap.set', { name: w.name, amount: formatUsd(parsed.capUsd) }),
      )
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card
      title={t('admin.workspaces.cap.title')}
      description={t('admin.workspaces.cap.description')}
      className="adm-detail"
    >
      <form onSubmit={save} className="adm-cap-form">
        <FormField
          id="adm-spending-cap"
          label={t('admin.workspaces.cap.label')}
          aside={t('admin.workspaces.cap.aside')}
          error={problem}
        >
          <Input
            id="adm-spending-cap"
            inputMode="decimal"
            placeholder={t('admin.workspaces.cap.placeholder')}
            value={text}
            invalid={!!problem}
            onChange={e => setText(e.target.value)}
          />
        </FormField>
        <Button type="submit" variant="primary" disabled={saving || text.trim() === saved}>
          {t('common.action.save')}
        </Button>
      </form>
      {reached && (
        <Note tone="danger" className="adm-cap-note">
          {t('admin.workspaces.cap.reached')}
        </Note>
      )}
    </Card>
  )
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
