// Workspace settings › Danger zone: leaving the workspace (everyone) and deleting it (owners only). The delete asks
// the server what goes first (workspace.deletePreview), shows it with the name typed to confirm, and needs a fresh
// sign-in: the passkey when the owner has one (PasskeyStepUpHost, mounted in Workspace.tsx), else a sign-in in the
// last 10 minutes ("Sign in again" comes back here and opens the dialog again). Afterwards the tab moves on like
// after leaving: into the next workspace, the no-workspace page, or the sign-in page when the account went too.
import type { OwnerStepUp, WorkspaceDeleteOwnData, WorkspaceDeletePreviewData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { StepUpRequired, stepUpOf, withPasskeyStepUp } from '../admin/PasskeyStepUp.tsx'
import { auth } from '../auth.ts'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'
import { signInAgain, signOutAndForget } from '../localData.ts'
import { markDeleted } from '../session.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { tabWorkspace, workspaceHeaders } from '../tabWorkspace.ts'
import { LeaveWorkspace } from '../team/TeamPage.tsx'
import { useTeam } from '../team/team-api.ts'
import { useSupportAccess } from '../supportAccess.ts'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { deleteOwnConfirmation, ownAccountWarning, reopenAfterSignIn, takeReopen } from './dangerZoneModel.ts'
import { Section } from './fields.tsx'

/** The server wants a sign-in in the last 10 minutes first (apps/api/src/owner-step-up.ts). */
class SignInFirst extends Error {}

async function post<T>(name: string, input: object): Promise<T> {
  const res = await fetch(`/v1/actions/${name}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...workspaceHeaders(), 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean
    error?: string
    code?: string
    stepUp?: unknown
    data?: T
  } | null
  const { t } = i18n()
  const stepUp = stepUpOf(body)
  if (stepUp) throw new StepUpRequired(body?.error ?? t('settings.danger.error.passkey'), stepUp)
  if (body?.code === 'SIGN_IN_AGAIN') throw new SignInFirst(body.error ?? t('settings.danger.error.signInAgain'))
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? t('settings.danger.error.status', { status: res.status }))
  return body.data as T
}

/**
 * Deletes the workspace. When the server asks for the passkey, the passkey dialog signs in again (a new session,
 * on no workspace yet): the retry first makes this workspace the session's again.
 */
function deleteOwn(workspaceId: string, name: string, keepAccounts: boolean) {
  const { t } = i18n()
  let attempt = 0
  return withPasskeyStepUp(async () => {
    if (attempt++ > 0) {
      const r = await auth.organization.setActive({ organizationId: workspaceId })
      if (r.error) throw new Error(r.error.message ?? t('settings.danger.error.reopen'))
    }
    return post<WorkspaceDeleteOwnData>('workspace.deleteOwn', { name, keepAccounts })
  }, t('settings.danger.delete.stepUpWhat'))
}

/** Where the tab goes once the workspace is gone; the next screen says what happened (session.ts, markDeleted). */
async function leaveDeleted(name: string, data: WorkspaceDeleteOwnData) {
  markDeleted({ name, accountDeleted: data.ownAccountDeleted })
  if (data.ownAccountDeleted) {
    // The account and its sessions are gone: forget what this browser kept, then the sign-in page.
    await signOutAndForget().catch(() => {})
    window.location.replace('/')
    return
  }
  if (data.nextWorkspaceId) await switchToWorkspace(data.nextWorkspaceId)
  else window.location.replace('/')
}

type Props = { workspaceName: string; isInstanceAdmin: boolean }

export function DangerZone({ workspaceName, isInstanceAdmin }: Props) {
  const t = useT()
  const team = useTeam()
  const supportAccess = useSupportAccess()
  const data = team.data ?? null
  // Leaving and deleting are the person's own: never during support access (apps/api/src/impersonation-guard.ts).
  if (supportAccess)
    return (
      <Section id="team-leave" title={t('settings.workspace.nav.danger.label')}>
        <span className="help">{t('settings.readOnly.supportAccess')}</span>
      </Section>
    )
  if (!data)
    return (
      <Section id="team-leave" title={t('settings.danger.leave.title')}>
        <Loading
          what={t('settings.danger.leave.loading')}
          loading
          error={team.error}
          onRetry={() => void team.reload()}
          skeleton={<Skeleton width={150} height={32} />}
        />
      </Section>
    )
  const role = data.members.find(m => m.userId === data.me)?.role
  return (
    <>
      <LeaveWorkspace data={data} isInstanceAdmin={isInstanceAdmin} />
      {role === 'owner' && <DeleteWorkspace workspaceName={workspaceName} />}
      {role === 'admin' && (
        <Section id="ws-delete" title={t('settings.danger.delete.action')}>
          <span className="help">{t('settings.danger.delete.onlyOwner')}</span>
        </Section>
      )}
    </>
  )
}

type Preview =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ready'; preview: WorkspaceDeletePreviewData }

function DeleteWorkspace({ workspaceName }: Pick<Props, 'workspaceName'>) {
  const t = useT()
  const workspaceId = tabWorkspace()
  const [open, setOpen] = useState(false)
  // Back from "Sign in again": the dialog opens again.
  useEffect(() => {
    if (workspaceId && takeReopen(workspaceId)) setOpen(true)
  }, [workspaceId])
  return (
    <Section id="ws-delete" title={t('settings.danger.delete.action')}>
      <div className="team-leave">
        <Button variant="danger-outline" title={t('settings.danger.delete.buttonTip')} onClick={() => setOpen(true)}>
          {t('settings.danger.delete.button')}
        </Button>
        <span className="help">{t('settings.danger.delete.help', { name: workspaceName })}</span>
      </div>
      {open && workspaceId && <DeleteDialog workspaceId={workspaceId} onClose={() => setOpen(false)} />}
    </Section>
  )
}

function DeleteDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT()
  const [preview, setPreview] = useState<Preview>({ state: 'loading' })
  // What the server asks for before deleting: from the preview, or from a refusal while the dialog was open.
  const [stepUp, setStepUp] = useState<OwnerStepUp | null>(null)
  useEffect(() => {
    let live = true
    post<WorkspaceDeletePreviewData>('workspace.deletePreview', {})
      .then(p => {
        if (!live) return
        setPreview({ state: 'ready', preview: p })
        setStepUp(p.stepUp)
      })
      .catch((err: unknown) => {
        if (live) setPreview({ state: 'error', error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      live = false
    }
  }, [])

  if (preview.state !== 'ready') {
    // Until the counts are known: the same dialog, nothing to confirm yet.
    return (
      <DangerConfirmDialog
        confirm={{ text: t('settings.danger.delete.finding'), action: t('settings.danger.delete.action') }}
        run={async () => {}}
        onClose={onClose}
        blocked
      >
        {preview.state === 'error' && <Note tone="danger">{preview.error}</Note>}
      </DangerConfirmDialog>
    )
  }
  const p = preview.preview
  const brand = brandName()
  async function run(keepAccounts: boolean) {
    try {
      const data = await deleteOwn(workspaceId, p.name, keepAccounts)
      await leaveDeleted(p.name, data)
    } catch (err) {
      if (err instanceof SignInFirst) setStepUp('signIn')
      throw err
    }
  }
  function signInFirst() {
    reopenAfterSignIn(workspaceId)
    // Signing in comes back to this page, in this workspace (`?ws=`), and the dialog opens again.
    window.history.replaceState(null, '', `#workspace/danger?ws=${encodeURIComponent(workspaceId)}`)
    void signInAgain()
  }
  return (
    <DangerConfirmDialog
      confirm={deleteOwnConfirmation(p, brand)}
      run={run}
      onClose={onClose}
      blocked={stepUp === 'signIn'}
      explains={err => err instanceof SignInFirst}
    >
      {keep => {
        const warning = ownAccountWarning(p, keep)
        return (
          <>
            {warning && (
              <Note tone={warning.tone} title={warning.title}>
                {warning.text}
              </Note>
            )}
            {stepUp === 'signIn' && (
              <Note
                tone="warning"
                title={t('settings.danger.signIn.title')}
                action={
                  <Button size="sm" title={t('settings.danger.signIn.buttonTip')} onClick={signInFirst}>
                    {t('settings.danger.signIn.button')}
                  </Button>
                }
              >
                {t('settings.danger.signIn.text')}
              </Note>
            )}
            {stepUp === 'passkey' && <Note tone="info">{t('settings.danger.passkeyNote')}</Note>}
          </>
        )
      }}
    </DangerConfirmDialog>
  )
}
