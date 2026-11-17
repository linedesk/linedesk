// Partner › Brand (docs/white-label.md, S4): the product name, logo, color, support email and terms and privacy links
// the partner's clients see instead of the install's, with a preview of the sign-in page and of one email. Its own file
// so the partner area (PartnerArea.tsx) only mounts it. The owner edits it (`partnerBrand.set`); the team sees it.
// Emails carry the brand once the partner is approved and has paid once; the note above the form says which is missing.
import {
  DEFAULT_PRODUCT_NAME,
  PARTNER_BRAND_CODES,
  type PartnerBrand as PartnerBrandVersion,
  type PartnerBrandData,
  type PartnerBrandInput,
  readableOn,
} from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { type FormEvent, useRef, useState } from 'react'
import { ColorField, logoAsPng, nameProblem, parsedColor } from '../admin/Branding.tsx'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { callAction } from '../settings/settings-api.ts'
import { Select } from '../ui/controls.tsx'
import { Card, FormField, FormMessage, Input, onSaveKey, SaveBar } from '../ui/form.tsx'
import { Button, LogoMark, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { changedFields, FIELD_KEY } from './brandChanges.ts'
import { partnerErrorText } from './partner-api.ts'
import './partner-brand.css'

const DEFAULT_COLOR = '#1c1917'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const BRAND_QUERY = (partnerId: string) => `partner.${partnerId}.brand`
const loadBrand = (partnerId: string) => callAction<PartnerBrandData>('partnerBrand.get', { partnerId })

type Draft = {
  name: string
  /** As typed (parsedColor). */
  color: string
  /** A new logo as a PNG data URL, null to remove it; undefined keeps the saved one. */
  logo: string | null | undefined
  supportEmail: string
  termsUrl: string
  privacyUrl: string
}

const draftOf = (data: PartnerBrandData, fallbackName: string): Draft => ({
  name: data.brand?.name ?? fallbackName,
  color: data.brand?.color ?? '',
  logo: undefined,
  supportEmail: data.brand?.supportEmail ?? '',
  termsUrl: data.brand?.termsUrl ?? '',
  privacyUrl: data.brand?.privacyUrl ?? '',
})

/** An https link, or empty: what the server takes for the terms and privacy links. */
export function httpsProblem(text: string): boolean {
  if (!text.trim()) return false
  try {
    const url = new URL(text.trim())
    return url.protocol !== 'https:' || !url.hostname
  } catch {
    return true
  }
}

const orNull = (text: string) => text.trim() || null

/** What the server is sent for the draft. */
export function inputOf(partnerId: string, draft: Draft): PartnerBrandInput {
  const input: PartnerBrandInput = {
    partnerId,
    name: draft.name.trim(),
    color: parsedColor(draft.color) ?? null,
    supportEmail: orNull(draft.supportEmail)?.toLowerCase() ?? null,
    termsUrl: orNull(draft.termsUrl),
    privacyUrl: orNull(draft.privacyUrl),
  }
  if (draft.logo !== undefined) input.logo = draft.logo
  return input
}

// i18n-dynamic: team.partner.brand.error.*
function brandErrorText(err: unknown, t: ReturnType<typeof useT>) {
  const code = (err as { code?: string }).code
  if (code && (PARTNER_BRAND_CODES as readonly string[]).includes(code))
    return t(`team.partner.brand.error.${code}` as MessageKey)
  return partnerErrorText(err)
}

export function PartnerBrand({ partnerId, partnerName }: { partnerId: string; partnerName: string }) {
  const t = useT()
  const query = useQuery(BRAND_QUERY(partnerId), () => loadBrand(partnerId))
  return (
    <Loading
      what={t('team.partner.brand.title')}
      loading={!query.data}
      error={query.error}
      onRetry={() => void query.reload()}
      skeleton={<SkeletonRows rows={4} columns={2} />}
    >
      {query.data && (
        <BrandForm
          key={JSON.stringify(query.data.brand)}
          partnerId={partnerId}
          partnerName={partnerName}
          data={query.data}
          onSaved={data => setQueryData(BRAND_QUERY(partnerId), data)}
        />
      )}
    </Loading>
  )
}

/**
 * Where the brand stands: a server admin reviews every change of name, logo, support email or links before clients and
 * their emails get it (security review of #1111, M-2), and the note names what waits; then emails also wait for
 * approval and the first invoice.
 */
function ReviewNote({ data }: { data: PartnerBrandData }) {
  const t = useT()
  const format = useFormat()
  if (!data.brand) return null
  if (data.review.state === 'none') return <Note tone="info">{t('team.partner.brand.reviewNone')}</Note>
  if (data.review.state === 'pending') {
    const fields = changedFields(data.brand, data.review.approved).map(f => t(FIELD_KEY[f]))
    return (
      <Note tone="info" title={t('team.partner.brand.reviewWaiting', { fields: format.list(fields) })}>
        {t('team.partner.brand.reviewPending', { name: data.review.approved?.name ?? data.brand.name })}
      </Note>
    )
  }
  if (data.emails.active) return <Note tone="info">{t('team.partner.brand.emailsActive')}</Note>
  return (
    <Note tone="info">
      {!data.emails.approved ? t('team.partner.brand.emailsAfterApproval') : t('team.partner.brand.emailsAfterPayment')}
    </Note>
  )
}

function BrandForm({
  partnerId,
  partnerName,
  data,
  onSaved,
}: {
  partnerId: string
  partnerName: string
  data: PartnerBrandData
  onSaved: (data: PartnerBrandData) => void
}) {
  const t = useT()
  const saved = draftOf(data, partnerName)
  const [draft, setDraft] = useState<Draft>(saved)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const update = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))
  const nameKey = nameProblem(draft.name)
  const emailInvalid = !!draft.supportEmail.trim() && !EMAIL.test(draft.supportEmail.trim())
  const termsInvalid = httpsProblem(draft.termsUrl)
  const privacyInvalid = httpsProblem(draft.privacyUrl)
  const invalid = !!nameKey || parsedColor(draft.color) === undefined || emailInvalid || termsInvalid || privacyInvalid
  const dirty = !data.brand || JSON.stringify(draft) !== JSON.stringify(saved)
  const readOnly = !data.canEdit
  const logo = draft.logo === undefined ? (data.brand?.logoUrl ?? null) : draft.logo
  // A change of name, logo, support email or links goes to a server admin first: the button says so.
  const forReview =
    changedFields(
      {
        name: draft.name.trim(),
        logoUrl: logo,
        supportEmail: orNull(draft.supportEmail)?.toLowerCase() ?? null,
        termsUrl: orNull(draft.termsUrl),
        privacyUrl: orNull(draft.privacyUrl),
      },
      data.review.approved,
    ).length > 0

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!dirty || invalid || readOnly) return
    setSaving(true)
    setProblem(null)
    try {
      onSaved(await callAction<PartnerBrandData>('partnerBrand.set', inputOf(partnerId, draft)))
    } catch (err) {
      setProblem(brandErrorText(err, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="pb-form" onSubmit={save} onKeyDown={e => onSaveKey(e, dirty && !invalid && !saving && !readOnly)}>
      {readOnly && <Note tone="neutral">{t('team.partner.brand.ownerOnly')}</Note>}
      <ReviewNote data={data} />
      <Card
        title={t('team.partner.brand.title')}
        description={t('team.partner.brand.description')}
        help={t('team.partner.brand.help')}
      >
        <fieldset className="pb-fields" disabled={readOnly}>
          <FormField id="pb-name" label={t('admin.branding.name')} error={nameKey && t(nameKey)}>
            <Input
              id="pb-name"
              value={draft.name}
              maxLength={40}
              invalid={!!nameKey}
              onChange={e => update({ name: e.target.value })}
            />
          </FormField>
          <LogoField
            logo={logo}
            hasSaved={!!data.brand?.logoUrl}
            readOnly={readOnly}
            onChange={next => update({ logo: next })}
          />
          <ColorField text={draft.color} onChange={color => update({ color })} />
          <FormField
            id="pb-support"
            label={t('team.partner.brand.supportEmail')}
            description={t('team.partner.brand.supportEmailHelp')}
            error={emailInvalid ? t('team.partner.brand.supportEmailInvalid') : null}
          >
            <Input
              id="pb-support"
              type="email"
              value={draft.supportEmail}
              invalid={emailInvalid}
              onChange={e => update({ supportEmail: e.target.value })}
            />
          </FormField>
          <FormField
            id="pb-terms"
            label={t('team.partner.brand.termsUrl')}
            error={termsInvalid ? t('team.partner.brand.urlInvalid') : null}
          >
            <Input
              id="pb-terms"
              type="url"
              placeholder={t('team.partner.brand.urlPlaceholder')}
              value={draft.termsUrl}
              invalid={termsInvalid}
              onChange={e => update({ termsUrl: e.target.value })}
            />
          </FormField>
          <FormField
            id="pb-privacy"
            label={t('team.partner.brand.privacyUrl')}
            error={privacyInvalid ? t('team.partner.brand.urlInvalid') : null}
          >
            <Input
              id="pb-privacy"
              type="url"
              placeholder={t('team.partner.brand.urlPlaceholder')}
              value={draft.privacyUrl}
              invalid={privacyInvalid}
              onChange={e => update({ privacyUrl: e.target.value })}
            />
          </FormField>
        </fieldset>
      </Card>
      <Previews draft={draft} logo={logo} approved={data.review.state === 'pending' ? data.review.approved : null} />
      {problem && <FormMessage>{problem}</FormMessage>}
      {!readOnly && (
        <SaveBar
          dirty={dirty}
          saving={saving}
          disabled={invalid}
          label={forReview ? t('team.partner.brand.sendForReview') : undefined}
          note={forReview ? t('team.partner.brand.sendForReviewNote') : undefined}
          onCancel={() => setDraft(saved)}
        />
      )}
    </form>
  )
}

function LogoField({
  logo,
  hasSaved,
  readOnly,
  onChange,
}: {
  logo: string | null
  hasSaved: boolean
  /** The team's view: the logo without Upload and Remove. */
  readOnly: boolean
  onChange: (logo: string | null | undefined) => void
}) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  async function pick(file: File | undefined) {
    if (!file) return
    setProblem(null)
    try {
      // Drawn into a PNG in the browser; the server checks it again and only ever serves a PNG (decodeLogo).
      onChange(await logoAsPng(file))
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t('admin.branding.logoUnreadable'))
    }
  }
  return (
    <FormField
      id="pb-logo"
      label={t('admin.branding.logo')}
      description={readOnly ? undefined : t('team.partner.brand.logoHelp')}
      error={problem}
    >
      <div className="adm-brand-logo">
        <span className="ws-mark adm-brand-logo-mark" aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <LogoMark />}
        </span>
        <input
          ref={fileRef}
          id="pb-logo"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
          hidden
          onChange={e => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {!readOnly && (
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            {logo ? t('admin.branding.replace') : t('admin.branding.upload')}
          </Button>
        )}
        {logo && !readOnly && (
          <Button size="sm" variant="ghost" onClick={() => onChange(hasSaved ? null : undefined)}>
            {t('admin.branding.remove')}
          </Button>
        )}
      </div>
    </FormField>
  )
}

/**
 * The sign-in page and a call email as the partner's clients see them: with the change, or (while a change waits for
 * review) as they see it now, the approved version.
 */
function Previews({
  draft: change,
  logo: changeLogo,
  approved,
}: {
  draft: Draft
  logo: string | null
  /** The approved version while a change waits for review: the previews can show it instead. */
  approved: PartnerBrandVersion | null
}) {
  const t = useT()
  const [mode, setMode] = useState<'change' | 'now'>('change')
  const now = mode === 'now' && approved
  const draft: Draft = now
    ? {
        name: approved.name,
        color: approved.color ?? '',
        logo: undefined,
        supportEmail: approved.supportEmail ?? '',
        termsUrl: approved.termsUrl ?? '',
        privacyUrl: approved.privacyUrl ?? '',
      }
    : change
  const logo = now ? approved.logoUrl : changeLogo
  const name = draft.name.trim() || DEFAULT_PRODUCT_NAME
  const color = parsedColor(draft.color) ?? DEFAULT_COLOR
  const button = { background: color, color: readableOn(color) }
  const mark = (
    <span className={logo ? 'ws-mark is-logo' : 'ws-mark'} aria-hidden="true">
      {logo ? <img src={logo} alt="" /> : <LogoMark />}
    </span>
  )
  const links = [
    draft.supportEmail.trim() && t('common.legal.help'),
    draft.termsUrl.trim() && t('common.legal.terms'),
    draft.privacyUrl.trim() && t('common.legal.privacy'),
  ].filter(Boolean)
  return (
    <Card
      title={t('admin.branding.preview')}
      help={t('team.partner.brand.previewNote')}
      actions={
        approved && (
          <Select
            size="sm"
            align="end"
            value={mode}
            label={t('team.partner.brand.previewWhich')}
            onChange={setMode}
            options={[
              { value: 'change', label: t('team.partner.brand.previewChange') },
              { value: 'now', label: t('team.partner.brand.previewNow') },
            ]}
          />
        )
      }
    >
      <div className="pb-previews">
        <section className="pb-preview" aria-label={t('team.partner.brand.previewSignIn')}>
          <p className="pb-preview-label">{t('team.partner.brand.previewSignIn')}</p>
          <div className="pb-signin">
            <div className="pb-head">
              {mark}
              <b>{name}</b>
            </div>
            <p className="pb-heading">{t('team.partner.brand.sampleSignIn', { brand: name })}</p>
            <span className="pb-field" />
            <span className="k-btn k-btn-sm pb-sample" style={button}>
              {t('team.partner.brand.sampleContinue')}
            </span>
            {links.length > 0 && <p className="pb-links">{links.join(' · ')}</p>}
          </div>
        </section>
        <section className="pb-preview" aria-label={t('team.partner.brand.previewEmail')}>
          <p className="pb-preview-label">{t('team.partner.brand.previewEmail')}</p>
          <div className="pb-email">
            <div className="pb-head">
              {mark}
              <b>{name}</b>
            </div>
            <div className="pb-email-card">
              <p className="pb-heading">{t('team.partner.brand.sampleEmailHeading')}</p>
              <p className="pb-muted">{t('team.partner.brand.sampleEmailText')}</p>
              <span className="k-btn k-btn-sm pb-sample" style={button}>
                {t('team.partner.brand.sampleEmailButton')}
              </span>
            </div>
            <p className="pb-links">
              {draft.supportEmail.trim()
                ? t('team.partner.brand.sampleReplyTo', { brand: name, email: draft.supportEmail.trim() })
                : name}
            </p>
          </div>
        </section>
      </div>
    </Card>
  )
}
