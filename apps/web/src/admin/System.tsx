// System: LiveKit, part of the install (its keys are set in env at install time, so this is a
// read-only status, loaded on its own because a server that is down takes seconds to say so), and
// whether workspaces may clone voices (off until an instance admin turns it on), where transfers may call (InternationalTransfers.tsx), and
// whether users are emailed when an admin signs in as them (off by default), and what Zapier needs from this server.
import {
  type ImpersonationEmailsData,
  type VoiceCloningData,
  ZAPIER_APP_URL,
  ZAPIER_HOOKS_HOST,
  zapierCanReach,
} from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Switch } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type LivekitStatus, loadLivekitStatus, runAdmin, type ServiceStatus } from './api.ts'
import { brandName } from '../brand.ts'
import { externalLink } from '../settings/ZapierGuide.tsx'
import { appLink } from '../ui/AppLink.tsx'
import { InternationalTransfers } from './InternationalTransfers.tsx'

const LIVEKIT = 'admin.livekit'

function Service({ name, status }: { name: string; status: ServiceStatus | null }) {
  const t = useT()
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span className={cx('adm-tile-status', status && !status.ok && 'adm-status-bad')}>
          <StatusMark state={!status ? 'checking' : status.ok ? 'works' : 'failing'} label={status?.message} />
          {!status
            ? t('admin.system.checking')
            : status.ok
              ? status.message
              : t('admin.system.problem', { message: status.message })}
        </span>
      </dd>
    </div>
  )
}

function Livekit() {
  const t = useT()
  const query = useQuery(LIVEKIT, loadLivekitStatus)
  const status = query.data ?? null
  const error = status ? null : query.error
  /** The operator pressed Check again: only then does the button spin (page data never does). */
  const [asked, setAsked] = useState(false)
  const check = async () => {
    setAsked(true)
    setQueryData<LivekitStatus | undefined>(LIVEKIT, undefined) // a check the operator asked for shows as checking
    try {
      await query.reload()
    } finally {
      setAsked(false)
    }
  }

  return (
    <Card
      title="LiveKit"
      actions={
        <Button busy={asked} size="sm" variant="ghost" disabled={!status && !error} onClick={() => void check()}>
          {asked ? t('admin.system.checking') : t('admin.system.checkAgain')}
        </Button>
      }
    >
      {error ? (
        <p className="k-field-msg" role="alert">
          {t('admin.system.couldNotCheck', { error })}
        </p>
      ) : (
        <dl className="adm-facts" aria-live="polite">
          <div>
            <dt>{t('admin.system.url')}</dt>
            <dd className="adm-mono">
              {status ? (
                (status.url ?? t('admin.system.notSet'))
              ) : (
                <Loading what={t('admin.system.urlWhat')} loading skeleton={<Skeleton shape="text" width={180} />} />
              )}
            </dd>
          </div>
          <Service name={t('admin.system.server')} status={status?.server ?? null} />
          <Service name={t('admin.system.sipTrunks')} status={status?.sip ?? null} />
        </dl>
      )}
    </Card>
  )
}

const CLONING = 'admin.voiceCloning'
const IMPERSONATION_EMAILS = 'admin.impersonationEmails'
const loadImpersonationEmails = async () => (await runAdmin('impersonationEmails.get', {})) as ImpersonationEmailsData

/**
 * Support access: whether a user gets one email when an admin signs in as them (Users or Workspaces, "Sign in as …"),
 * with the admin, the reason, the time and the workspace. Off by default.
 */
function ImpersonationEmails() {
  const t = useT()
  const query = useQuery(IMPERSONATION_EMAILS, loadImpersonationEmails)
  const [problem, setProblem] = useState<string | null>(null)
  const data = query.data
  const on = data?.on ?? false
  async function change(next: boolean) {
    if (!data) return
    setProblem(null)
    setQueryData<ImpersonationEmailsData | undefined>(IMPERSONATION_EMAILS, { ...data, on: next })
    try {
      await runAdmin('impersonationEmails.set', { on: next })
    } catch (e) {
      setQueryData<ImpersonationEmailsData | undefined>(IMPERSONATION_EMAILS, { ...data, on: !next })
      setProblem(e instanceof Error ? e.message : t('admin.system.impersonationEmailsFailed'))
    }
  }
  return (
    <Card title={t('admin.system.impersonationEmails')} help={t('admin.system.impersonationEmailsHelp')}>
      <div className="swrow">
        <div>
          <b>{t('admin.system.impersonationEmailsSend')}</b>
          {data && !data.emailConnected && (
            <span className="help">{t('admin.system.impersonationEmailsNotConnected')}</span>
          )}
        </div>
        <Loading
          what={t('admin.system.impersonationEmails')}
          loading={!data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch
            on={on}
            onChange={v => void change(v)}
            label={t('admin.system.impersonationEmailsSend')}
            disabled={!data}
          />
        </Loading>
      </div>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </Card>
  )
}

const loadCloning = async () => (await runAdmin('voiceCloning.get', {})) as VoiceCloningData

/** Voice cloning for every workspace: off by default; existing clones keep working when it is turned off. */
function VoiceCloning() {
  const t = useT()
  const query = useQuery(CLONING, loadCloning)
  const [problem, setProblem] = useState<string | null>(null)
  const on = query.data?.on ?? false
  async function change(next: boolean) {
    setProblem(null)
    setQueryData<VoiceCloningData | undefined>(CLONING, { on: next })
    try {
      await runAdmin('voiceCloning.set', { on: next })
    } catch (e) {
      setQueryData<VoiceCloningData | undefined>(CLONING, { on: !next })
      setProblem(e instanceof Error ? e.message : t('admin.system.cloningFailed'))
    }
  }
  return (
    <Card title={t('admin.system.cloning')} help={t('admin.system.cloningHelp', { brand: brandName() })}>
      <div className="swrow">
        <div>
          <b>{t('admin.system.cloningAllow')}</b>
        </div>
        <Loading
          what={t('admin.system.cloning')}
          loading={!query.data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch
            on={on}
            onChange={v => void change(v)}
            label={t('admin.system.cloningAllow')}
            disabled={!query.data}
          />
        </Loading>
      </div>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </Card>
  )
}

/**
 * Zapier: one Linedesk app on Zapier serves every install, so a self-hosted server sets up nothing; each workspace
 * connects it with its own key and this address. The server only has to be reachable by Zapier, and reach Zapier.
 */
function Zapier() {
  const t = useT()
  const address = window.location.origin
  const reachable = zapierCanReach(address)
  return (
    <Card title={t('admin.system.zapier')} help={t('admin.system.zapierHelp')}>
      <dl className="adm-facts">
        <div>
          <dt>{t('admin.system.zapierAddress')}</dt>
          <dd>
            <span className={cx('adm-tile-status', !reachable && 'adm-status-bad')}>
              <StatusMark state={reachable ? 'works' : 'failing'} />
              {reachable
                ? t('admin.system.zapierReachable', { address })
                : t('admin.system.zapierUnreachable', { address })}
            </span>
          </dd>
        </div>
      </dl>
      <p className="help">
        <T
          k="admin.system.zapierSteps"
          values={{
            app: externalLink(ZAPIER_APP_URL),
            link: appLink('#integrations/zapier'),
            host: ZAPIER_HOOKS_HOST,
          }}
        />
      </p>
    </Card>
  )
}

export function System() {
  return (
    <>
      <Livekit />
      <VoiceCloning />
      <InternationalTransfers />
      <ImpersonationEmails />
      <Zapier />
    </>
  )
}
