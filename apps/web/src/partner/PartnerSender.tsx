// Partner › Email sender (docs/white-label.md, S6): the partner's clients' emails come from an address on the partner's
// own domain once the email provider verified its DNS records, and replies go to the support email once its owner
// proved it with a code. Until then emails come from the standard address with the partner's name, without Reply-To.
// The owner changes it; the team sees the same page without buttons.
import {
  PARTNER_SENDER_CODES,
  type PartnerSenderData,
  type PartnerSenderState,
  type SenderRecord,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { CopyButton } from '../onboarding/Frame.tsx'
import { callAction } from '../settings/settings-api.ts'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { Card, Dialog, FormField, Input } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { partnerErrorText } from './partner-api.ts'
import './partner-sender.css'

export const PARTNER_SENDER_QUERY = (partnerId: string) => `partner.${partnerId}.sender`
const loadSender = (partnerId: string) => callAction<PartnerSenderData>('partnerSender.get', { partnerId })

/** A refusal with a sender code in the page's words, else the partner area's wording. */
// i18n-dynamic: team.partner.sender.error.*
export function senderErrorText(err: unknown): string {
  const code = (err as { code?: string }).code
  if (code && (PARTNER_SENDER_CODES as readonly string[]).includes(code))
    return i18n().t(`team.partner.sender.error.${code}` as MessageKey)
  return partnerErrorText(err)
}

/** The mark of the sender's state. */
export const senderMark = (status: PartnerSenderState) =>
  status === 'verified' ? 'works' : status === 'failed' ? 'failing' : status === 'stopped' ? 'off' : 'checking'

/** The line that says what the state means for the partner's emails. */
export function senderLead(status: PartnerSenderState): MessageKey {
  if (status === 'verified') return msg('team.partner.sender.verifiedLead')
  if (status === 'failed') return msg('team.partner.sender.failedLead')
  if (status === 'stopped') return msg('team.partner.sender.stoppedLead')
  return msg('team.partner.sender.pendingLead')
}

/**
 * The DNS records the partner adds at its DNS host: type, name and value in full (never cut short: they are copied),
 * each with Copy buttons; the buttons go under the value on phones.
 */
export function DnsRecords({ records }: { records: SenderRecord[] }) {
  const t = useT()
  return (
    <ul className="ps-records" aria-label={t('team.partner.sender.records')}>
      {records.map(r => (
        <li key={`${r.type}:${r.name}:${r.value}`} className="ps-record">
          <div className="ps-record-text">
            <span className="ps-record-head">
              {r.type} · <code>{r.name}</code>
              {r.priority !== null && ` · ${t('team.partner.sender.priority', { priority: r.priority })}`}
              {r.found && <StatusMark state="works" label={t('team.partner.sender.recordFound')} />}
            </span>
            <code className="ps-value">{r.value}</code>
          </div>
          <div className="ps-record-copy">
            <CopyButton text={r.name} label={t('team.partner.sender.copyName')} />
            <CopyButton text={r.value} label={t('team.partner.sender.copyValue')} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The sender's state, records and buttons, without data loading: also what the tests render. */
export function SenderBody({
  data,
  busy,
  onAdd,
  onCheck,
  onTest,
  onRemove,
  onVerifySupport,
}: {
  data: PartnerSenderData
  busy: string | null
  onAdd: (address: string) => void
  onCheck: () => void
  onTest: () => void
  onRemove: () => void
  onVerifySupport: () => void
}) {
  const t = useT()
  const [address, setAddress] = useState('')
  const edit = data.canEdit
  if (!data.available) return <p className="help">{t('team.partner.sender.unavailable')}</p>
  const sender = data.sender
  return (
    <>
      {data.removedByAdmin && !sender && (
        <Note tone="warning">
          {t('team.partner.sender.removedByAdmin', {
            address: data.removedByAdmin.address,
            reason: data.removedByAdmin.reason,
          })}
        </Note>
      )}
      {!sender && data.locked && (
        <p className="help">
          {data.locked.brandApproved ? t('team.partner.sender.lockedPaid') : t('team.partner.sender.lockedBrand')}
        </p>
      )}
      {!sender && !data.locked && edit && (
        <form
          className="ps-form"
          onSubmit={e => {
            e.preventDefault()
            if (address.trim()) onAdd(address.trim())
          }}
        >
          <FormField
            id="partner-sender-address"
            label={t('team.partner.sender.address')}
            help={t('team.partner.sender.addressHelp')}
          >
            <Input
              id="partner-sender-address"
              type="email"
              autoComplete="off"
              placeholder={t('team.partner.sender.addressPlaceholder')}
              value={address}
              onChange={e => setAddress(e.target.value)}
            />
          </FormField>
          <Button type="submit" busy={busy === 'add'} disabled={!address.trim() || !!busy}>
            {t('team.partner.sender.continue')}
          </Button>
        </form>
      )}
      {sender && (
        <>
          <div className="ps-head">
            <StatusMark state={senderMark(sender.status)} />
            <div>
              <strong>{sender.address}</strong>
              <p className="help">
                {t(senderLead(sender.status))}
              </p>
            </div>
          </div>
          {sender.status !== 'verified' && (
            <>
              <p>{t('team.partner.sender.addRecords')}</p>
              <DnsRecords records={sender.records} />
            </>
          )}
          {edit && (
            <div className="ps-actions">
              {sender.status === 'verified' ? (
                <Button size="sm" busy={busy === 'test'} disabled={!!busy} onClick={onTest}>
                  {t('team.partner.sender.sendTest')}
                </Button>
              ) : (
                <Button size="sm" busy={busy === 'check'} disabled={!!busy} onClick={onCheck}>
                  {t('team.partner.sender.checkNow')}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={onRemove}>
                {t('team.partner.sender.remove')}
              </Button>
            </div>
          )}
        </>
      )}
      <p className="help">{t('team.partner.sender.fromLine', { from: data.fromLine })}</p>
      <List label={t('team.partner.sender.replyTitle')}>
        <ListRow
          title={
            <>
              <span className="k-row-text">{t('team.partner.sender.replyTitle')}</span>
              {data.support.address && (
                <StatusMark
                  state={data.support.verified ? 'works' : 'untested'}
                  label={
                    data.support.verified ? t('team.partner.sender.replyVerified') : t('team.partner.sender.replyNot')
                  }
                />
              )}
            </>
          }
          sub={
            data.support.address
              ? data.support.verified
                ? t('team.partner.sender.replyTo', { address: data.support.address })
                : t('team.partner.sender.replyUnverified', { address: data.support.address })
              : t('team.partner.sender.replyNone')
          }
          actions={
            edit &&
            data.support.address &&
            !data.support.verified && (
              <Button size="sm" disabled={!!busy} onClick={onVerifySupport}>
                {t('team.partner.sender.verify')}
              </Button>
            )
          }
        />
      </List>
      {!edit && <p className="help">{t('team.partner.sender.ownerOnly')}</p>}
    </>
  )
}

export function PartnerSender({ partnerId, toast }: { partnerId: string; toast: (text: string) => void }) {
  const t = useT()
  const query = useQuery(PARTNER_SENDER_QUERY(partnerId), () => loadSender(partnerId))
  const data = query.data
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [codeFor, setCodeFor] = useState<string | null>(null)
  const store = (next: PartnerSenderData) => setQueryData(PARTNER_SENDER_QUERY(partnerId), next)

  async function run(what: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(what)
    setProblem(null)
    try {
      await work()
    } catch (err) {
      setProblem(senderErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card
      title={t('team.partner.sender.title')}
      description={t('team.partner.sender.description')}
      help={t('team.partner.sender.help')}
    >
      <Loading
        what={t('team.partner.sender.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={3} columns={2} />}
      >
        {data && (
          <>
            <SenderBody
              data={data}
              busy={busy}
              onAdd={address =>
                void run('add', async () => {
                  store(await callAction<PartnerSenderData>('partnerSender.add', { partnerId, address }))
                })
              }
              onCheck={() =>
                void run('check', async () => {
                  const next = await callAction<PartnerSenderData>('partnerSender.check', { partnerId })
                  store(next)
                  toast(
                    next.sender?.status === 'verified'
                      ? t('team.partner.sender.nowVerified')
                      : t('team.partner.sender.notYet'),
                  )
                })
              }
              onTest={() =>
                void run('test', async () => {
                  const { sentTo } = await callAction<{ sentTo: string }>('partnerSender.sendTest', { partnerId })
                  toast(t('team.partner.sender.testSent', { to: sentTo }))
                })
              }
              onRemove={() => setRemoving(true)}
              onVerifySupport={() =>
                void run('code', async () => {
                  const { sentTo } = await callAction<{ sentTo: string }>('partnerBrand.verifySupportEmail', {
                    partnerId,
                  })
                  setCodeFor(sentTo)
                })
              }
            />
            {problem && (
              <Note tone="danger" role="alert">
                {problem}
              </Note>
            )}
          </>
        )}
      </Loading>
      {removing && data?.sender && (
        <DangerConfirmDialog
          confirm={{
            text: t('team.partner.sender.removeText', { address: data.sender.address }),
            action: t('team.partner.sender.removeAction'),
            variant: 'danger',
          }}
          run={async () => {
            store(await callAction<PartnerSenderData>('partnerSender.remove', { partnerId }))
            setRemoving(false)
            toast(t('team.partner.sender.removed'))
          }}
          onClose={() => setRemoving(false)}
        />
      )}
      {codeFor && (
        <SupportCode
          partnerId={partnerId}
          address={codeFor}
          onClose={() => setCodeFor(null)}
          onDone={next => {
            store(next)
            setCodeFor(null)
            toast(t('team.partner.sender.replyDone'))
          }}
        />
      )}
    </Card>
  )
}

/** The 6-digit code sent to the support email. */
function SupportCode({
  partnerId,
  address,
  onClose,
  onDone,
}: {
  partnerId: string
  address: string
  onClose: () => void
  onDone: (data: PartnerSenderData) => void
}) {
  const t = useT()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = /^\d{6}$/.test(code.trim())
  return (
    <Dialog
      title={t('team.partner.sender.codeTitle')}
      description={t('team.partner.sender.codeDescription', { address })}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={async e => {
        e.preventDefault()
        if (!ready || busy) return
        setBusy(true)
        setError(null)
        try {
          onDone(
            await callAction<PartnerSenderData>('partnerBrand.confirmSupportEmail', { partnerId, code: code.trim() }),
          )
        } catch (err) {
          setError(senderErrorText(err))
        } finally {
          setBusy(false)
        }
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={!ready}>
            {t('team.partner.sender.confirm')}
          </Button>
        </>
      }
    >
      <FormField id="partner-support-code" label={t('team.partner.sender.code')} error={error}>
        <Input
          id="partner-support-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          invalid={!!error}
          onChange={e => setCode(e.target.value)}
        />
      </FormField>
    </Dialog>
  )
}
