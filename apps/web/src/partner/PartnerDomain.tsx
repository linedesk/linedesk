// Partner › Domain (docs/white-label.md, S5): the partner's own address (app.theiragency.com), where its clients sign in
// once it is live. The owner adds a subdomain, adds our TXT and the CNAME at its DNS host, and we check until the
// address and its certificate work. The team sees the same page without buttons.
import {
  PARTNER_DOMAIN_CODES,
  type PartnerDomainData,
  type PartnerDomainFailure,
  type PartnerDomainState,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { callAction } from '../settings/settings-api.ts'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { DnsRecords } from '../ui/DnsRecords.tsx'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { partnerErrorText } from './partner-api.ts'
import './partner-sender.css'

export const PARTNER_DOMAIN_QUERY = (partnerId: string) => `partner.${partnerId}.domain`
const loadDomain = (partnerId: string) => callAction<PartnerDomainData>('partnerDomain.get', { partnerId })

/** A refusal with a domain code in the page's words, else the partner area's wording. */
// i18n-dynamic: team.partner.domain.error.*
export function domainErrorText(err: unknown): string {
  const code = (err as { code?: string }).code
  if (code && (PARTNER_DOMAIN_CODES as readonly string[]).includes(code))
    return i18n().t(`team.partner.domain.error.${code}` as MessageKey)
  return partnerErrorText(err)
}

/** The mark of the address's state. */
export const domainMark = (status: PartnerDomainState) =>
  status === 'active' ? 'works' : status === 'failed' ? 'failing' : status === 'stopped' ? 'off' : 'checking'

/** The line that says what the state means for the partner's clients. */
export function domainLead(status: PartnerDomainState, failure: PartnerDomainFailure | null): MessageKey {
  if (status === 'active') return msg('team.partner.domain.activeLead')
  if (status === 'verifying') return msg('team.partner.domain.verifyingLead')
  if (status === 'stopped') return msg('team.partner.domain.stoppedLead')
  if (status === 'failed')
    return failure === 'cert_failed'
      ? msg('team.partner.domain.failedCertLead')
      : failure === 'probe_failed'
        ? msg('team.partner.domain.failedProbeLead')
        : msg('team.partner.domain.failedLead')
  return msg('team.partner.domain.pendingLead')
}

/** The address's state, records and buttons, without data loading: also what the tests render. */
export function DomainBody({
  data,
  busy,
  onAdd,
  onCheck,
  onRemove,
}: {
  data: PartnerDomainData
  busy: string | null
  onAdd: (hostname: string) => void
  onCheck: () => void
  onRemove: () => void
}) {
  const t = useT()
  const [hostname, setHostname] = useState('')
  const edit = data.canEdit
  if (!data.available) return <p className="help">{t('team.partner.domain.unavailable')}</p>
  const domain = data.domain
  return (
    <>
      {data.removed && !domain && (
        <Note tone="warning">
          {data.removed.byAdmin
            ? t('team.partner.domain.removedByAdmin', { hostname: data.removed.hostname, reason: data.removed.reason })
            : t('team.partner.domain.expired', { hostname: data.removed.hostname })}
        </Note>
      )}
      {!domain && data.locked && (
        <p className="help">
          {data.locked.brandApproved ? t('team.partner.domain.lockedPaid') : t('team.partner.domain.lockedBrand')}
        </p>
      )}
      {!domain && !data.locked && edit && (
        <form
          className="ps-form"
          onSubmit={e => {
            e.preventDefault()
            if (hostname.trim()) onAdd(hostname.trim())
          }}
        >
          <FormField
            id="partner-domain-hostname"
            label={t('team.partner.domain.hostname')}
            help={t('team.partner.domain.hostnameHelp')}
          >
            <Input
              id="partner-domain-hostname"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t('team.partner.domain.hostnamePlaceholder')}
              value={hostname}
              onChange={e => setHostname(e.target.value)}
            />
          </FormField>
          <Button type="submit" busy={busy === 'add'} disabled={!hostname.trim() || !!busy}>
            {t('team.partner.domain.continue')}
          </Button>
        </form>
      )}
      {!domain && !data.locked && !edit && <p className="help">{t('team.partner.domain.none')}</p>}
      {domain && (
        <>
          <div className="ps-head">
            <StatusMark state={domainMark(domain.status)} />
            <div>
              <strong>{domain.hostname}</strong>
              <p className="help">{t(domainLead(domain.status, domain.failure))}</p>
            </div>
          </div>
          {domain.status !== 'active' && (
            <>
              <p>{t('team.partner.domain.addRecords')}</p>
              <DnsRecords records={domain.records} />
            </>
          )}
          {edit && (
            <div className="ps-actions">
              {domain.status !== 'active' && (
                <Button size="sm" busy={busy === 'check'} disabled={!!busy} onClick={onCheck}>
                  {t('team.partner.domain.checkNow')}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={onRemove}>
                {t('team.partner.domain.remove')}
              </Button>
            </div>
          )}
        </>
      )}
      {domain && !edit && <p className="help">{t('team.partner.domain.ownerOnly')}</p>}
    </>
  )
}

export function PartnerDomain({ partnerId, toast }: { partnerId: string; toast: (text: string) => void }) {
  const t = useT()
  const query = useQuery(PARTNER_DOMAIN_QUERY(partnerId), () => loadDomain(partnerId))
  const data = query.data
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const store = (next: PartnerDomainData) => setQueryData(PARTNER_DOMAIN_QUERY(partnerId), next)

  async function run(what: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(what)
    setProblem(null)
    try {
      await work()
    } catch (err) {
      setProblem(domainErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card
      title={t('team.partner.domain.title')}
      description={t('team.partner.domain.description')}
      help={t('team.partner.domain.help')}
    >
      <Loading
        what={t('team.partner.domain.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={2} columns={2} />}
      >
        {data && (
          <>
            <DomainBody
              data={data}
              busy={busy}
              onAdd={hostname =>
                void run('add', async () => {
                  store(await callAction<PartnerDomainData>('partnerDomain.add', { partnerId, hostname }))
                })
              }
              onCheck={() =>
                void run('check', async () => {
                  const next = await callAction<PartnerDomainData>('partnerDomain.check', { partnerId })
                  store(next)
                  toast(
                    next.domain?.status === 'active'
                      ? t('team.partner.domain.nowActive')
                      : t('team.partner.domain.notYet'),
                  )
                })
              }
              onRemove={() => setRemoving(true)}
            />
            {problem && (
              <Note tone="danger" role="alert">
                {problem}
              </Note>
            )}
          </>
        )}
      </Loading>
      {removing && data?.domain && (
        <DangerConfirmDialog
          confirm={{
            text: t('team.partner.domain.removeText', { hostname: data.domain.hostname }),
            action: t('team.partner.domain.removeAction'),
            typed: data.domain.hostname,
            variant: 'danger',
          }}
          run={async () => {
            const hostname = data.domain!.hostname
            store(await callAction<PartnerDomainData>('partnerDomain.remove', { partnerId, hostname }))
            setRemoving(false)
            toast(t('team.partner.domain.removed'))
          }}
          onClose={() => setRemoving(false)}
        />
      )}
    </Card>
  )
}
