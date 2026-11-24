// Server admin › Partners › Brands (docs/white-label.md, S4; security review of #1111, M-2): every white-label partner's
// brand, the change it waits to have reviewed next to the version its clients see now. An instance admin approves a
// change (clients and their emails get it from then on) or removes the brand (clients see this server's again), each
// with a reason for the audit log. On the "Waiting for approval" tab only the brands that wait for a review.
import {
  PARTNER_BRAND_REVIEW_CODES,
  type PartnerBrand,
  type PartnerBrandReview,
  type PartnerBrandReviewList,
} from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { changedFields, type ReviewedField } from '../partner/brandChanges.ts'
import { useSupportAccess } from '../supportAccess.ts'
import { Card, Dialog, FormField, FormMessage, Textarea } from '../ui/form.tsx'
import { Badge, Button, cx } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'
import { reasonProblem } from './billingModel.ts'
import { errorText, type Notify } from './notify.ts'
import { waitingBrands } from './partnersModel.ts'
import { day, EMPTY } from './parts.tsx'
import './partner-brands.css'

export const BRAND_REVIEWS = 'admin.partners.brands'
export const loadBrandReviews = async () => (await runAdmin('partnerBrand.reviews', {})) as PartnerBrandReviewList

// i18n-dynamic: admin.partners.brands.error.*
/** A refusal's own text (the partner changed its brand meanwhile, the brand is gone), else the server's. */
function reviewErrorText(err: unknown, t: ReturnType<typeof useT>) {
  const code = (err as { code?: string }).code
  if (code && (PARTNER_BRAND_REVIEW_CODES as readonly string[]).includes(code))
    return t(`admin.partners.brands.error.${code}` as MessageKey)
  return errorText(err)
}

/** `waiting`: only the brands that wait for a review (the "Waiting for approval" tab); gone when none waits. */
export function PartnerBrands({ notify, waiting = false }: { notify: Notify; waiting?: boolean }) {
  const t = useT()
  const supportAccess = useSupportAccess()
  const query = useQuery(supportAccess ? null : BRAND_REVIEWS, loadBrandReviews)
  const [asking, setAsking] = useState<{ brand: PartnerBrandReview; action: 'approve' | 'reset' } | null>(null)
  const all = query.data?.brands ?? []
  const brands = waiting ? waitingBrands(all) : all
  if (waiting && (!query.data || brands.length === 0) && !asking) return null
  const title = waiting ? t('admin.partners.brands.waitingTitle') : t('admin.partners.brands.title')

  return (
    <Card
      title={title}
      description={waiting ? t('admin.partners.brands.waitingDescription') : t('admin.partners.brands.description')}
    >
      <Loading
        what={title}
        loading={!query.data && !supportAccess}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={2} columns={1} />}
      >
        {query.data && brands.length === 0 ? (
          <p className="adm-notice">{t('admin.partners.brands.empty')}</p>
        ) : (
          <ul className="apb-list">
            {brands.map(brand => (
              <li key={brand.partnerId} className="apb-item">
                <div className="apb-head">
                  <strong>{brand.partner}</strong>
                  <StateBadge brand={brand} />
                  <span className="adm-sub">{t('admin.partners.brands.changedAt', { day: day(brand.updatedAt) })}</span>
                </div>
                <div className="apb-versions">
                  {brand.state !== 'approved' && (
                    <Version
                      title={t('admin.partners.brands.draft')}
                      brand={brand.draft}
                      changed={new Set(changedFields(brand.draft, brand.approved))}
                    />
                  )}
                  <Version title={t('admin.partners.brands.approved')} brand={brand.approved} at={brand.approvedAt} />
                </div>
                <div className="adm-actbar">
                  {brand.state !== 'approved' && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={supportAccess}
                      title={t('admin.partners.brands.approveTip', { name: brand.partner })}
                      onClick={() => setAsking({ brand, action: 'approve' })}
                    >
                      {t('admin.partners.brands.approve')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={supportAccess}
                    title={t('admin.partners.brands.resetTip', { name: brand.partner })}
                    onClick={() => setAsking({ brand, action: 'reset' })}
                  >
                    {t('admin.partners.brands.reset')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Loading>
      {asking && (
        <ReviewDialog
          brand={asking.brand}
          action={asking.action}
          onClose={() => setAsking(null)}
          onDone={async text => {
            setAsking(null)
            notify(text)
            await query.reload()
          }}
        />
      )}
    </Card>
  )
}

function StateBadge({ brand }: { brand: PartnerBrandReview }) {
  const t = useT()
  if (brand.state === 'approved') return <Badge tone="ok">{t('admin.partners.brands.stateApproved')}</Badge>
  if (brand.state === 'pending') return <Badge tone="info">{t('admin.partners.brands.statePending')}</Badge>
  return <Badge tone="outline">{t('admin.partners.brands.stateNone')}</Badge>
}

/**
 * One version of a brand: what a person checks for a borrowed name, logo, address or link. `changed`: on the version
 * that waits for review, the fields that differ from what clients see now, marked so the reviewer sees the change.
 */
function Version({
  title,
  brand,
  at,
  changed,
}: {
  title: string
  brand: PartnerBrand | null
  at?: string | null
  changed?: ReadonlySet<ReviewedField>
}) {
  const t = useT()
  const mark = (field: ReviewedField, className?: string) =>
    cx(className, changed?.has(field) && 'is-changed') || undefined
  const tag = (field: ReviewedField) =>
    changed?.has(field) ? <span className="apb-tag">{t('admin.partners.brands.changed')}</span> : null
  return (
    <div className="apb-version">
      <p className="apb-version-title">
        {title}
        {at && <span className="adm-sub-inline"> · {day(at)}</span>}
      </p>
      {!brand ? (
        <p className="adm-sub">{t('admin.partners.brands.noneApproved')}</p>
      ) : (
        <dl className="apb-facts">
          <dt>{t('admin.branding.name')}</dt>
          <dd className={mark(changed?.has('logo') ? 'logo' : 'name', 'apb-name')}>
            {brand.logoUrl && <img className="apb-logo" src={brand.logoUrl} alt="" />}
            {brand.name}
            {tag('name') ?? tag('logo')}
          </dd>
          <dt>{t('team.partner.brand.supportEmail')}</dt>
          <dd className={mark('supportEmail')}>
            {brand.supportEmail ?? EMPTY}
            {tag('supportEmail')}
          </dd>
          <dt>{t('team.partner.brand.termsUrl')}</dt>
          <dd className={mark('termsUrl', 'apb-link')}>
            {brand.termsUrl ?? EMPTY}
            {tag('termsUrl')}
          </dd>
          <dt>{t('team.partner.brand.privacyUrl')}</dt>
          <dd className={mark('privacyUrl', 'apb-link')}>
            {brand.privacyUrl ?? EMPTY}
            {tag('privacyUrl')}
          </dd>
        </dl>
      )}
    </div>
  )
}

/** Approve or remove a brand: both ask why, and the reason is kept in the audit log. */
function ReviewDialog({
  brand,
  action,
  onClose,
  onDone,
}: {
  brand: PartnerBrandReview
  action: 'approve' | 'reset'
  onClose: () => void
  onDone: (text: string) => Promise<void>
}) {
  const t = useT()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const approve = action === 'approve'

  async function submit(e: FormEvent) {
    e.preventDefault()
    const why = reasonProblem(reason)
    setReasonError(why)
    if (why || busy) return
    setProblem(null)
    setBusy(true)
    try {
      if (approve)
        await runAdmin('partnerBrand.approve', {
          partnerId: brand.partnerId,
          revision: brand.revision,
          contentHash: brand.contentHash,
          reason: reason.trim(),
        })
      else await runAdmin('partnerBrand.reset', { partnerId: brand.partnerId, reason: reason.trim() })
      await onDone(
        t(approve ? 'admin.partners.brands.approveDone' : 'admin.partners.brands.resetDone', {
          name: brand.partner,
        }),
      )
    } catch (err) {
      setProblem(reviewErrorText(err, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t(approve ? 'admin.partners.brands.approveTitle' : 'admin.partners.brands.resetTitle', {
        name: brand.partner,
      })}
      description={t(approve ? 'admin.partners.brands.approveText' : 'admin.partners.brands.resetText')}
      onClose={onClose}
      onSubmit={e => void submit(e)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button type="submit" variant={approve ? 'primary' : 'danger'} busy={busy}>
            {t(approve ? 'admin.partners.brands.approve' : 'admin.partners.brands.reset')}
          </Button>
        </>
      }
    >
      <FormField
        id="apb-reason"
        label={t('admin.bills.reason.label')}
        aside={t('admin.bills.reason.aside')}
        error={reasonError}
      >
        <Textarea
          id="apb-reason"
          rows={2}
          value={reason}
          invalid={!!reasonError}
          placeholder={t('admin.bills.reason.placeholder')}
          onChange={e => setReason(e.target.value)}
        />
      </FormField>
      {problem && <FormMessage>{problem}</FormMessage>}
    </Dialog>
  )
}
