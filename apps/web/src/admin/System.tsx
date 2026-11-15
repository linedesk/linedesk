// System: LiveKit, part of the install (its keys are set in env at install time, so this is a
// read-only status, loaded on its own because a server that is down takes seconds to say so), and
// whether workspaces may clone voices (off until an instance admin turns it on), and where outbound calls may go.
import {
  countryList,
  type OutboundCountriesData,
  parseCountryList,
  phoneCountryName,
  type VoiceCloningData,
} from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Checkbox, Switch } from '../ui/controls.tsx'
import { Card, Input } from '../ui/form.tsx'
import { Button, cx, Note } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type LivekitStatus, loadLivekitStatus, runAdmin, type ServiceStatus } from './api.ts'
import { brandName } from '../brand.ts'
import { fmt } from '../i18n/format.ts'

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

const OUTBOUND = 'admin.outboundCountries'
const loadOutbound = async () => (await runAdmin('outboundCountries.get', {})) as OutboundCountriesData

/**
 * Where transfers and forwarding checks may call: every workspace the countries of its own numbers, plus the
 * countries allowed here for the whole install (or by OUTBOUND_COUNTRIES). With today's use, the limits, and the
 * countries the install's Twilio account still blocks (its Geo permissions are changed in Twilio, never by Linedesk).
 */
function OutboundCalls() {
  const t = useT()
  const query = useQuery(OUTBOUND, loadOutbound)
  const data = query.data ?? null
  const [typed, setTyped] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const value = typed ?? data?.countries.join(', ') ?? ''
  const wanted = parseCountryList(value)
  const unknown = value.split(/[\s,;]+/).filter(c => c.trim() && !wanted.includes(c.trim().toUpperCase()))
  const changed = !!data && wanted.join() !== data.countries.join()
  // Frequent toll-fraud destinations being added: saved only after a second, explicit confirmation.
  const risky = data ? wanted.filter(c => data.highRisk.includes(c) && !data.countries.includes(c)) : []
  const [confirmed, setConfirmed] = useState(false)
  async function save() {
    setProblem(null)
    setBusy(true)
    try {
      const saved = (await runAdmin('outboundCountries.set', {
        countries: wanted,
        ...(risky.length && confirmed ? { confirmHighRisk: risky } : {}),
      })) as OutboundCountriesData
      setConfirmed(false)
      setQueryData<OutboundCountriesData | undefined>(OUTBOUND, saved)
      setTyped(null)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t('admin.system.outboundFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title={t('admin.system.outbound')} help={t('admin.system.outboundHelp')}>
      <Loading
        what={t('admin.system.outboundWhat')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<Skeleton shape="text" width={240} />}
      >
        {data && (
          <>
            <label className="k-field-label" htmlFor="adm-outbound">
              {t('admin.system.outboundLabel')}
            </label>
            <div className="ob2-row">
              <Input
                id="adm-outbound"
                value={value}
                placeholder={t('admin.system.outboundPlaceholder')}
                disabled={data.fromEnv || busy}
                invalid={unknown.length > 0}
                onChange={e => {
                  setTyped(e.target.value)
                  setConfirmed(false)
                }}
              />
              {!data.fromEnv && (
                <Button
                  busy={busy}
                  disabled={!changed || unknown.length > 0 || (risky.length > 0 && !confirmed)}
                  onClick={() => void save()}
                >
                  {t('common.action.save')}
                </Button>
              )}
            </div>
            <p className="k-field-msg">
              {unknown.length
                ? t('admin.system.notCountryCode', {
                    count: unknown.length,
                    codes: fmt().list(unknown, { type: 'unit', style: 'short' }),
                  })
                : wanted.length
                  ? t('admin.system.allowedBesides', { countries: countryList(wanted) })
                  : t('admin.system.onlyOwn')}
              {data.fromEnv && ` ${t('admin.system.fromEnv', { env: 'OUTBOUND_COUNTRIES' })}`}
            </p>
            {risky.length > 0 && !data.fromEnv && (
              <Note tone="danger">
                {t('admin.system.riskyWarning', { count: risky.length, countries: countryList(risky) })}
                <Checkbox checked={confirmed} onChange={setConfirmed}>
                  {t('admin.system.riskyConfirm', { countries: countryList(risky) })}
                </Checkbox>
              </Note>
            )}
            {data.twilioBlocked?.length ? (
              <Note tone="warning">
                {t('admin.system.twilioBlocked', {
                  countries: countryList(data.twilioBlocked),
                  names: fmt().list(data.twilioBlocked.map(phoneCountryName), { type: 'unit', style: 'short' }),
                })}
              </Note>
            ) : null}
            <dl className="adm-facts">
              <div>
                <dt>{t('admin.system.last24h')}</dt>
                <dd>
                  {t('admin.system.usage', {
                    transfers: data.usage.transfers,
                    minutes: data.usage.transferMinutes,
                    installMinutes: data.usage.installTransferMinutes,
                    checks: data.usage.forwardingChecks,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('admin.system.limits')}</dt>
                <dd>
                  {data.limits.minutesPerWorkspaceDay && data.limits.minutesInstallDay && data.limits.transferMaxMinutes
                    ? t('admin.system.limitsText', {
                        workspace: data.limits.minutesPerWorkspaceDay,
                        install: data.limits.minutesInstallDay,
                        perCall: data.limits.transferMaxMinutes,
                      })
                    : t('admin.system.transfersOff')}
                </dd>
              </div>
            </dl>
          </>
        )}
      </Loading>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </Card>
  )
}

export function System() {
  return (
    <>
      <Livekit />
      <VoiceCloning />
      <OutboundCalls />
    </>
  )
}
