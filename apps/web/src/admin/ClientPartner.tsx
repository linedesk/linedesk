// Server admin › Workspaces › Partner… (LIN-530): move a workspace to another white-label partner, add it to one, or
// take it from its partner (`partner.adminMoveClient`). The shared type-to-confirm dialog with a partner picker: what
// changes is listed for the picked choice, the workspace's name unlocks the button, the reason goes to the audit log.
import { type AdminPartnerList, PARTNER_CODES } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { Select } from '../ui/controls.tsx'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { FormField } from '../ui/form.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { Note } from '../ui/kit.tsx'
import { type AdminWorkspace, runAdmin } from './api.ts'
import type { Notify } from './notify.ts'

type Partner = AdminPartnerList['partners'][number]
const PARTNERS = 'admin.partners'
const load = async () => (await runAdmin('partner.adminList', {})) as AdminPartnerList
/** The picker's value for "no partner". */
export const NO_PARTNER = ''

type Translate = ReturnType<typeof useT>

/** What the picked change does, one line each, for the dialog's list. */
export function clientPartnerLines(
  t: Translate,
  from: Pick<Partner, 'name' | 'billingAccountId'> | null,
  to: Pick<Partner, 'name' | 'billingAccountId'> | null,
): string[] {
  const lines: string[] = []
  if (from) lines.push(t('admin.clientPartner.line.leaves', { partner: from.name }))
  if (to) lines.push(t('admin.clientPartner.line.joins', { partner: to.name }))
  if (to?.billingAccountId) lines.push(t('admin.clientPartner.line.toBill', { partner: to.name }))
  else if (!to && from?.billingAccountId) lines.push(t('admin.clientPartner.line.ownBill'))
  lines.push(t('admin.clientPartner.line.stays'))
  return lines
}

/** A partner refusal in the app's words; anything else as it came. */
function refusalOf(t: Translate, err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'client_no_owner') return new Error(t('admin.clientPartner.noOwner'))
  return typeof code === 'string' && (PARTNER_CODES as readonly string[]).includes(code)
    ? new Error(t(`team.partner.error.${code}` as MessageKey))
    : err
}

export function ClientPartnerDialog({
  workspace: w,
  onClose,
  notify,
  reload,
}: {
  workspace: AdminWorkspace
  onClose: () => void
  notify: Notify
  reload: () => Promise<void>
}) {
  const t = useT()
  const query = useQuery(PARTNERS, load)
  const partners = query.data?.partners ?? []
  const current = w.partner_id ?? NO_PARTNER
  const [picked, setPicked] = useState<string | null>(null)
  const from = partners.find(p => p.id === w.partner_id) ?? null
  const to = picked ? (partners.find(p => p.id === picked) ?? null) : null
  const chosen = picked !== null
  const action = !chosen
    ? t('admin.clientPartner.action.move')
    : picked === NO_PARTNER
      ? t('admin.clientPartner.action.remove')
      : from
        ? t('admin.clientPartner.action.move')
        : t('admin.clientPartner.action.add')
  const options = [
    ...partners
      .filter(p => p.status !== 'suspended' || p.id === w.partner_id)
      .map(p => ({
        value: p.id,
        label: p.name,
        disabled: p.id === w.partner_id,
        description: p.id === w.partner_id ? t('admin.clientPartner.current') : undefined,
      })),
    ...(w.partner_id ? [{ value: NO_PARTNER, label: t('admin.clientPartner.none') }] : []),
  ]
  return (
    <DangerConfirmDialog
      confirm={{
        text: w.partner_name
          ? t('admin.clientPartner.textWith', { name: w.name, partner: w.partner_name })
          : t('admin.clientPartner.textWithout', { name: w.name }),
        action,
        busyAction: t('admin.clientPartner.busy'),
        typed: w.name,
        variant: 'primary',
        reason: {
          label: t('admin.bills.reason.label'),
          placeholder: t('admin.bills.reason.placeholder'),
          min: 3,
          max: 500,
        },
      }}
      blocked={!chosen}
      choice={picked}
      run={async (_option, reason) => {
        if (picked === null) return
        try {
          await runAdmin('partner.adminMoveClient', {
            workspaceId: w.id,
            toPartnerId: picked === NO_PARTNER ? null : picked,
            confirmName: w.name,
            reason,
          })
        } catch (err) {
          throw refusalOf(t, err)
        }
        await Promise.all([reload(), query.reload()])
        notify(
          picked === NO_PARTNER
            ? t('admin.clientPartner.done.removed', { name: w.name })
            : t('admin.clientPartner.done.moved', { name: w.name, partner: to?.name ?? '' }),
        )
        onClose()
      }}
      onClose={onClose}
    >
      <Loading
        what={t('admin.clientPartner.loading')}
        loading={!query.data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonFields fields={1} />}
      >
        <FormField id="adm-client-partner" label={t('admin.clientPartner.label')}>
          <Select
            id="adm-client-partner"
            value={picked ?? current}
            onChange={setPicked}
            label={t('admin.clientPartner.label')}
            options={options}
          />
        </FormField>
      </Loading>
      {chosen && (
        <Note>
          <ul className="danger-confirm-list">
            {clientPartnerLines(t, from, picked === NO_PARTNER ? null : to).map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Note>
      )}
    </DangerConfirmDialog>
  )
}
