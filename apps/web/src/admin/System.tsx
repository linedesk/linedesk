// System: LiveKit, part of the install (its keys are set in env at install time, so this is a
// read-only status, loaded on its own because a server that is down takes seconds to say so), and
// whether workspaces may clone voices (off until an instance admin turns it on), where transfers may call (InternationalTransfers.tsx), and
// whether users are emailed when an admin signs in as them (off by default), German numbers held in this server's name
// (off by default), who may sign up in which country (open, only invited emails or off; Germany once German numbers
// are on: SignupAccess.tsx), and what Zapier needs from this server.
import {
  areaCodeShown,
  type GermanGroupData,
  type GermanGroupState,
  type ImpersonationEmailsData,
  type GermanNumbersData,
  type StatusState,
  type VoiceCloningData,
  ZAPIER_APP_URL,
  ZAPIER_HOOKS_HOST,
  zapierCanReach,
} from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { brandName } from '../brand.ts'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { externalLink } from '../settings/ZapierGuide.tsx'
import { appLink, ExternalLink, LinkButton } from '../ui/AppLink.tsx'
import { Switch } from '../ui/controls.tsx'
import { Field } from '../settings/fields.tsx'
import { Card, Input } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type LivekitStatus, loadLivekitStatus, runAdmin, type ServiceStatus } from './api.ts'
import { InternationalTransfers } from './InternationalTransfers.tsx'
import { SignupAccess } from './SignupAccess.tsx'

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

const GERMAN_NUMBERS = 'admin.germanNumbers'
const GERMAN_GROUP = 'admin.germanNumbers.group'
const loadGermanNumbers = async () => (await runAdmin('germanNumbers.get', {})) as GermanNumbersData
const loadGermanGroup = async () => (await runAdmin('germanNumbers.group', {})) as GermanGroupData

const NO_GROUP_READ: GermanGroupData = {
  id: '',
  state: 'none',
  mismatch: null,
  address: null,
  portalUrl: null,
  areaCode: null,
  checkedAt: '',
}

/** How each state of the requirement group is marked: the shape says it, colour never alone. */
const GROUP_MARK: Record<GermanGroupState, StatusState> = {
  none: 'missing',
  no_carrier: 'not_needed',
  not_found: 'failing',
  unreachable: 'untested',
  mismatch: 'failing',
  approved: 'works',
  in_review: 'partly',
  unapproved: 'partly',
  declined: 'failing',
  expired: 'failing',
}
const GROUP_BAD: ReadonlySet<GermanGroupState> = new Set(['not_found', 'mismatch', 'declined', 'expired'])

/**
 * The requirement group's state at the carrier, under its field: the state in a word, what it means for buying, the
 * address the group was approved for, and its page in the carrier's portal. Never blocks the card: a carrier that
 * does not answer is said calmly, with Check again.
 */
function GroupStatus({
  group,
  loading,
  numberType,
  onCheck,
}: {
  group: GermanGroupData | undefined
  loading: boolean
  numberType: string
  onCheck: () => void
}) {
  const t = useT()
  if (!group)
    return (
      <div className="adm-de-group" role="status">
        <StatusMark state="checking" />
        <div className="adm-de-group-text">
          <p>{t('admin.system.germanGroupChecking')}</p>
        </div>
      </div>
    )
  if (group.state === 'none') return null
  const words: Record<Exclude<GermanGroupState, 'none'>, { title: string; detail: string }> = {
    approved: { title: t('admin.system.germanGroupApproved'), detail: t('admin.system.germanGroupApprovedDetail') },
    in_review: { title: t('admin.system.germanGroupInReview'), detail: t('admin.system.germanGroupInReviewDetail') },
    unapproved: {
      title: t('admin.system.germanGroupUnapproved'),
      detail: t('admin.system.germanGroupUnapprovedDetail'),
    },
    declined: { title: t('admin.system.germanGroupDeclined'), detail: t('admin.system.germanGroupDeclinedDetail') },
    expired: { title: t('admin.system.germanGroupExpired'), detail: t('admin.system.germanGroupExpiredDetail') },
    not_found: { title: t('admin.system.germanGroupNotFound'), detail: t('admin.system.germanGroupNotFoundDetail') },
    unreachable: {
      title: t('admin.system.germanGroupUnreachable'),
      detail: t('admin.system.germanGroupUnreachableDetail'),
    },
    no_carrier: {
      title: t('admin.system.germanGroupNoCarrier'),
      detail: t('admin.system.germanGroupNoCarrierDetail'),
    },
    mismatch: {
      title: t('admin.system.germanGroupMismatch'),
      detail: t('admin.system.germanGroupMismatchDetail', {
        country: group.mismatch?.country || '?',
        numberType: group.mismatch?.numberType || '?',
        action: group.mismatch?.action || '?',
        wanted: numberType,
      }),
    },
  }
  const { title, detail } = words[group.state]
  const address = group.address
    ? [group.address.street, [group.address.postalCode, group.address.city].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : ''
  return (
    <div className="adm-de-group" role="status" aria-busy={loading}>
      <StatusMark state={loading ? 'checking' : GROUP_MARK[group.state]} label={title} />
      <div className="adm-de-group-text">
        <p>
          <b className={cx(GROUP_BAD.has(group.state) && 'adm-status-bad')}>{title}</b> <span>{detail}</span>
        </p>
        {address && <p>{t('admin.system.germanGroupAddress', { address })}</p>}
        <p className="adm-de-group-links">
          {group.portalUrl && <ExternalLink href={group.portalUrl}>{t('admin.system.germanGroupOpen')}</ExternalLink>}
          <LinkButton onClick={onCheck}>{t('admin.system.germanGroupCheck')}</LinkButton>
        </p>
      </div>
    </div>
  )
}

/**
 * German numbers held in this server's name (apps/api/src/number-buy.ts): on, German workspaces on this server's
 * carrier account buy a number like a US one, ordered with the server's own requirement group at the carrier (its
 * one-time KYC), so the business hands in no documents. Off by default. Workspaces on their own carrier account are
 * never affected. The area code is the one of the group's address (read from the carrier); only while none is found
 * for it does the card ask for one.
 */
function GermanNumbers() {
  const t = useT()
  const query = useQuery(GERMAN_NUMBERS, loadGermanNumbers)
  const data = query.data
  const groupQuery = useQuery(data?.requirementGroupId ? GERMAN_GROUP : null, loadGermanGroup)
  const [problem, setProblem] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [codes, setCodes] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  /** Reads the group at the carrier now (after a save, or Check again), then what is offered with it. */
  async function checkGroup() {
    setChecking(true)
    try {
      setQueryData<GermanGroupData | undefined>(
        GERMAN_GROUP,
        (await runAdmin('germanNumbers.group', { refresh: true })) as GermanGroupData,
      )
      setQueryData<GermanNumbersData | undefined>(GERMAN_NUMBERS, await loadGermanNumbers())
    } catch {
      // The card stays as it was; the status line keeps its last answer.
    } finally {
      setChecking(false)
    }
  }
  async function save(change: { on?: boolean; requirementGroupId?: string; areaCodes?: string[] }) {
    if (!data) return
    setProblem(null)
    setSaving(true)
    if (change.on !== undefined) setQueryData<GermanNumbersData | undefined>(GERMAN_NUMBERS, { ...data, ...change })
    try {
      const saved = (await runAdmin('germanNumbers.set', change)) as GermanNumbersData
      setQueryData<GermanNumbersData | undefined>(GERMAN_NUMBERS, saved)
      setGroup(null)
      setCodes(null)
      if (saved.requirementGroupId && change.on === undefined) void checkGroup()
    } catch (e) {
      setQueryData<GermanNumbersData | undefined>(GERMAN_NUMBERS, data)
      setProblem(e instanceof Error ? e.message : t('admin.system.germanNumbersFailed'))
    } finally {
      setSaving(false)
    }
  }
  // A read that failed in the app (offline) is said like a carrier that did not answer: calmly, with Check again.
  const groupData: GermanGroupData | undefined = !data?.requirementGroupId
    ? undefined
    : (groupQuery.data ??
      (groupQuery.error ? { ...NO_GROUP_READ, id: data.requirementGroupId, state: 'unreachable' } : undefined))
  const groupLoading = !!data?.requirementGroupId && !groupData
  // The area code found for the group's address: the carrier's latest answer, else the one the server keeps.
  const found = groupData
    ? groupData.areaCode
      ? { code: groupData.areaCode, city: groupData.address?.city ?? data?.areaCodeCity ?? '' }
      : null
    : data?.areaCodeCity
      ? { code: data.areaCodes[0] ?? '', city: data.areaCodeCity }
      : null
  const local = data?.numberType === 'local'
  // The typed area codes only while none is found for the group's address (and not while it is being read).
  const askCodes = !!data && local && !!data.requirementGroupId && !found && !groupLoading
  const groupValue = group ?? data?.requirementGroupId ?? ''
  const codesValue = codes ?? (data?.savedAreaCodes ?? []).map(c => `0${c}`).join(', ')
  const typedCodes = codesValue
    .split(/[\s,]+/)
    .map(c => c.replace(/^0/, ''))
    .filter(Boolean)
  const changed =
    !!data &&
    (groupValue.trim() !== data.requirementGroupId ||
      (askCodes && typedCodes.join(',') !== data.savedAreaCodes.join(',')))
  return (
    <Card title={t('admin.system.germanNumbers')} help={t('admin.system.germanNumbersHelp')}>
      <div className="swrow">
        <div>
          <b>{t('admin.system.germanNumbersOn')}</b>
          {data?.on && !data.requirementGroupId && (
            <span className="help">{t('admin.system.germanNumbersNoGroup')}</span>
          )}
        </div>
        <Loading
          what={t('admin.system.germanNumbers')}
          loading={!data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch
            on={data?.on ?? false}
            onChange={v => void save({ on: v })}
            label={t('admin.system.germanNumbersOn')}
            disabled={!data || saving}
          />
        </Loading>
      </div>
      {data && (
        <form
          className="adm-german-numbers"
          onSubmit={e => {
            e.preventDefault()
            if (changed)
              void save({ requirementGroupId: groupValue.trim(), ...(askCodes ? { areaCodes: typedCodes } : {}) })
          }}
        >
          <Field
            id="adm-de-group"
            label={t('admin.system.germanNumbersGroup')}
            help={t('admin.system.germanNumbersGroupHelp')}
          >
            <Input id="adm-de-group" value={groupValue} onChange={e => setGroup(e.target.value)} autoComplete="off" />
            {data.requirementGroupId && (
              <GroupStatus
                group={groupData}
                loading={checking || groupLoading}
                numberType={data.numberType}
                onCheck={() => void checkGroup()}
              />
            )}
          </Field>
          {local && found && (
            <div className="k-field" role="group" aria-labelledby="adm-de-area">
              <div className="k-field-label">
                <span id="adm-de-area" className="adm-de-area-label">
                  {t('admin.system.germanNumbersAreaCode')}
                </span>
              </div>
              <p className="adm-de-area">
                <b>{areaCodeShown(found.code, 'DE')}</b>
                {found.city && (
                  <span className="help">{t('admin.system.germanNumbersAreaCodeFrom', { city: found.city })}</span>
                )}
              </p>
            </div>
          )}
          {askCodes && (
            <Field
              id="adm-de-codes"
              label={t('admin.system.germanNumbersAreaCodes')}
              help={t('admin.system.germanNumbersAreaCodesHelp')}
            >
              <Input id="adm-de-codes" value={codesValue} onChange={e => setCodes(e.target.value)} autoComplete="off" />
            </Field>
          )}
          <div className="ob2-row">
            <Button type="submit" size="sm" disabled={!changed || saving} busy={saving}>
              {t('admin.system.germanNumbersSave')}
            </Button>
          </div>
          <p className={cx('help', data.numbers >= data.alertAt && 'adm-status-bad')} role="status">
            {data.numbers >= data.alertAt
              ? t('admin.system.germanNumbersCountWarn', { count: data.numbers })
              : t('admin.system.germanNumbersCount', { count: data.numbers })}
          </p>
        </form>
      )}
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
      <GermanNumbers />
      <SignupAccess />
      <ImpersonationEmails />
      <Zapier />
    </>
  )
}
