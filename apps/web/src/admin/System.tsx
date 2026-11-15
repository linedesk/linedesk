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
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Checkbox, Switch } from '../ui/controls.tsx'
import { Card, Input } from '../ui/form.tsx'
import { Button, cx, Note } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type LivekitStatus, loadLivekitStatus, runAdmin, type ServiceStatus } from './api.ts'
import { brandName } from '../brand.ts'

const LIVEKIT = 'admin.livekit'

function Service({ name, status }: { name: string; status: ServiceStatus | null }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span className={cx('adm-tile-status', status && !status.ok && 'adm-status-bad')}>
          <StatusMark state={!status ? 'checking' : status.ok ? 'works' : 'failing'} label={status?.message} />
          {!status ? 'Checking…' : status.ok ? status.message : `Problem: ${status.message}`}
        </span>
      </dd>
    </div>
  )
}

function Livekit() {
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
          {asked ? 'Checking…' : 'Check again'}
        </Button>
      }
    >
      {error ? (
        <p className="k-field-msg" role="alert">
          Could not check: {error}
        </p>
      ) : (
        <dl className="adm-facts" aria-live="polite">
          <div>
            <dt>URL</dt>
            <dd className="adm-mono">
              {status ? (
                (status.url ?? 'Not set')
              ) : (
                <Loading what="The URL" loading skeleton={<Skeleton shape="text" width={180} />} />
              )}
            </dd>
          </div>
          <Service name="Server" status={status?.server ?? null} />
          <Service name="SIP trunks" status={status?.sip ?? null} />
        </dl>
      )}
    </Card>
  )
}

const CLONING = 'admin.voiceCloning'
const loadCloning = async () => (await runAdmin('voiceCloning.get', {})) as VoiceCloningData

/** Voice cloning for every workspace: off by default; existing clones keep working when it is turned off. */
function VoiceCloning() {
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
      setProblem(e instanceof Error ? e.message : 'Could not change voice cloning.')
    }
  }
  return (
    <Card
      title="Voice cloning"
      help={`Lets workspaces create a voice from a recording of a real person, who must have agreed to it; ${brandName()} keeps who confirmed that and when. Turning this off stops new clones, but existing ones keep working.`}
    >
      <div className="swrow">
        <div>
          <b>Allow voice cloning</b>
        </div>
        <Loading
          what="Voice cloning"
          loading={!query.data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch on={on} onChange={v => void change(v)} label="Allow voice cloning" disabled={!query.data} />
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
      setProblem(e instanceof Error ? e.message : 'Could not save the countries.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title="Calls to other countries"
      help="Transfers and forwarding checks call out, and every call costs money. Each workspace may call the countries of its own phone numbers. Allow more countries only for businesses that need them: calls abroad cost more and are a common target of phone fraud."
    >
      <Loading
        what="Outbound countries"
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<Skeleton shape="text" width={240} />}
      >
        {data && (
          <>
            <label className="k-field-label" htmlFor="adm-outbound">
              Also allow, for calls through this server’s carrier account (country codes, like CA, MX)
            </label>
            <div className="ob2-row">
              <Input
                id="adm-outbound"
                value={value}
                placeholder="None: each workspace calls only its own numbers' countries"
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
                  Save
                </Button>
              )}
            </div>
            <p className="k-field-msg">
              {unknown.length
                ? `Not a country code: ${unknown.join(', ')}`
                : wanted.length
                  ? `Allowed besides their own: ${countryList(wanted)}.`
                  : 'Only the countries of each workspace’s own numbers.'}
              {data.fromEnv && ' Set by OUTBOUND_COUNTRIES on this server.'}
            </p>
            {risky.length > 0 && !data.fromEnv && (
              <Note tone="danger">
                {countryList(risky)} {risky.length === 1 ? 'is a' : 'are'} frequent toll-fraud destination
                {risky.length === 1 ? '' : 's'}: numbers there are rented to fraudsters who are paid for every minute
                called. Allow {risky.length === 1 ? 'it' : 'them'} only for a business you know needs it.
                <Checkbox checked={confirmed} onChange={setConfirmed}>
                  I understand the risk: allow calls to {countryList(risky)}
                </Checkbox>
              </Note>
            )}
            {data.twilioBlocked?.length ? (
              <Note tone="warning">
                Twilio blocks calls to {countryList(data.twilioBlocked)}. Turn on{' '}
                {data.twilioBlocked.map(phoneCountryName).join(', ')} in Twilio Console › Voice › Settings › Geo
                permissions.
              </Note>
            ) : null}
            <dl className="adm-facts">
              <div>
                <dt>Last 24 hours</dt>
                <dd>
                  {data.usage.transfers} transfers ({data.usage.transferMinutes} min,{' '}
                  {data.usage.installTransferMinutes} min of them through this server’s carrier account),{' '}
                  {data.usage.forwardingChecks} forwarding checks
                </dd>
              </div>
              <div>
                <dt>Limits</dt>
                <dd>
                  {data.limits.minutesPerWorkspaceDay && data.limits.minutesInstallDay && data.limits.transferMaxMinutes
                    ? `${data.limits.minutesPerWorkspaceDay} transfer minutes per workspace a day, ${data.limits.minutesInstallDay} for the whole server through its carrier account, ${data.limits.transferMaxMinutes} min per transferred call`
                    : 'Transfers are off (a limit is 0)'}
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
