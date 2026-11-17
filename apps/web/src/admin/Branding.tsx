// Branding: the product name, logo and primary color of the whole install, for people who run their own
// server under their own name (packages/actions/src/branding.ts), and the "Powered by Linedesk" line such an
// install shows (on by default; turning it off asks once, kindly, before it is hidden). Saved with branding.set;
// shown at once here and in this tab (setBrand), in other tabs and for other people on their next page load.
import {
  type Branding,
  type BrandingInput,
  DEFAULT_BRANDING,
  DEFAULT_PRODUCT_NAME,
  LOGO_MAX_BYTES,
  LOGO_SIZE,
  NAME_CONTROL_CHARACTERS,
  readableOn,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useRef, useState } from 'react'
import { setBrand, useBrand } from '../brand.ts'
import { Switch } from '../ui/controls.tsx'
import { Card, Dialog, FormField, FormMessage, Input, onSaveKey, SaveBar } from '../ui/form.tsx'
import { HelpTip } from '../ui/HelpTip.tsx'
import { Button, Icon, LogoMark } from '../ui/kit.tsx'
import { i18n } from '../i18n/index.tsx'
import { runAdmin } from './api.ts'

const DEFAULT_COLOR = '#1c1917'

const HEX = /^#[0-9a-fA-F]{6}$/

/** The color as typed: empty is the default (null), a #rrggbb color is used, anything else is not valid (undefined). */
export const parsedColor = (text: string): string | null | undefined =>
  text === '' ? null : HEX.test(text) ? text.toLowerCase() : undefined

type Draft = {
  name: string
  /** As typed, see parsedColor. */
  color: string
  /** A new logo as a PNG data URL, null to remove it; undefined keeps the saved one. */
  logo: string | null | undefined
  starPrompt: boolean
  poweredBy: boolean
}

const draftOf = (b: Branding): Draft => ({
  name: b.name,
  color: b.color ?? '',
  logo: undefined,
  starPrompt: b.starPrompt,
  poweredBy: b.poweredBy,
})

const isDirty = (d: Draft, b: Branding) =>
  d.name.trim() !== b.name ||
  parsedColor(d.color) !== b.color ||
  d.logo !== undefined ||
  d.starPrompt !== b.starPrompt ||
  d.poweredBy !== b.poweredBy

/**
 * Any image the browser can show, drawn centred on a transparent square of at most LOGO_SIZE pixels and
 * saved as PNG: the server only ever stores and serves a plain PNG, never an SVG that could carry script.
 */
export async function logoAsPng(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error(i18n().t('common.image.unreadable'))
    })
    const side = Math.min(LOGO_SIZE, Math.max(image.naturalWidth, image.naturalHeight) || LOGO_SIZE)
    const scale = side / Math.max(image.naturalWidth || side, image.naturalHeight || side)
    const width = (image.naturalWidth || side) * scale
    const height = (image.naturalHeight || side) * scale
    const canvas = document.createElement('canvas')
    canvas.width = side
    canvas.height = side
    canvas.getContext('2d')!.drawImage(image, (side - width) / 2, (side - height) / 2, width, height)
    const png = canvas.toDataURL('image/png')
    if ((png.length - 'data:image/png;base64,'.length) * 0.75 > LOGO_MAX_BYTES)
      throw new Error(
        i18n().t('common.image.tooLarge', { what: i18n().t('admin.branding.logoWhat'), kb: LOGO_MAX_BYTES / 1024 }),
      )
    return png
  } finally {
    URL.revokeObjectURL(url)
  }
}

function LogoField({
  draft,
  saved,
  onChange,
}: {
  draft: Draft
  saved: Branding
  onChange: (logo: string | null | undefined) => void
}) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const shown = draft.logo === undefined ? saved.logoUrl : draft.logo
  async function pick(file: File | undefined) {
    if (!file) return
    setProblem(null)
    try {
      onChange(await logoAsPng(file))
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t('admin.branding.logoUnreadable'))
    }
  }
  return (
    <FormField
      id="brand-logo"
      label={t('admin.branding.logo')}
      description={t('admin.branding.logoHelp')}
      error={problem}
    >
      <div className="adm-brand-logo">
        <span className="ws-mark adm-brand-logo-mark" aria-hidden="true">
          {shown ? <img src={shown} alt="" /> : <LogoMark />}
        </span>
        <input
          ref={fileRef}
          id="brand-logo"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
          hidden
          onChange={e => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
          {shown ? t('admin.branding.replace') : t('admin.branding.upload')}
        </Button>
        {shown && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(saved.logoUrl ? null : undefined)}
            title={t('admin.branding.removeTip')}
          >
            {t('admin.branding.remove')}
          </Button>
        )}
      </div>
    </FormField>
  )
}

export function ColorField({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const t = useT()
  const color = parsedColor(text)
  return (
    <FormField
      id="brand-color"
      label={t('admin.branding.color')}
      description={t('admin.branding.colorHelp')}
      error={color === undefined ? t('admin.branding.colorInvalid', { example: DEFAULT_COLOR }) : null}
    >
      <div className="adm-brand-color">
        <input
          type="color"
          aria-label={t('admin.branding.pickColor')}
          value={color ?? DEFAULT_COLOR}
          onChange={e => onChange(e.target.value)}
        />
        <Input
          id="brand-color"
          value={text}
          placeholder={DEFAULT_COLOR}
          invalid={color === undefined}
          spellCheck={false}
          onChange={e => onChange(e.target.value.trim())}
        />
        {text && (
          <Button size="sm" variant="ghost" onClick={() => onChange('')}>
            {t('admin.branding.defaultColor')}
          </Button>
        )}
      </div>
    </FormField>
  )
}

/** Asked before the "Powered by Linedesk" line is switched off: a kind request, and hiding it stays one click. */
function KeepPoweredByDialog({ onKeep, onHide }: { onKeep: () => void; onHide: () => void }) {
  const t = useT()
  return (
    <Dialog
      title={t('admin.branding.keepTitle', { brand: DEFAULT_PRODUCT_NAME })}
      size="sm"
      onClose={onKeep}
      footer={
        <>
          <Button variant="ghost" onClick={onHide}>
            {t('admin.branding.hideIt')}
          </Button>
          <Button variant="primary" onClick={onKeep}>
            {t('admin.branding.keepIt')}
          </Button>
        </>
      }
    >
      <p className="adm-brand-ask">{t('admin.branding.keepAsk', { brand: DEFAULT_PRODUCT_NAME })}</p>
    </Dialog>
  )
}

/** A switch row whose explanation sits behind a (?) next to its label. */
function SupportSwitch({
  label,
  help,
  on,
  onChange,
}: {
  label: string
  help: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="swrow">
      <span className="adm-brand-label">
        <b>{label}</b>
        <HelpTip text={help} />
      </span>
      <Switch on={on} onChange={onChange} label={label} />
    </div>
  )
}

/**
 * Support Linedesk: the optional ways an install helps the project (the GitHub star prompt and the "Powered by"
 * line), apart from the branding so they read as a favour, not as part of the look.
 */
export function SupportCard({
  starPrompt,
  poweredBy,
  onStarPrompt,
  onPoweredBy,
}: {
  starPrompt: boolean
  poweredBy: boolean
  onStarPrompt: (on: boolean) => void
  onPoweredBy: (on: boolean) => void
}) {
  const t = useT()
  return (
    <Card
      id="brand-support"
      title={
        <>
          <Icon name="heart" size={15} className="adm-brand-heart" />
          {t('admin.branding.supportTitle', { brand: DEFAULT_PRODUCT_NAME })}
        </>
      }
      description={t('admin.branding.supportDescription', { brand: DEFAULT_PRODUCT_NAME })}
    >
      <div className="st-swlist">
        <SupportSwitch
          label={t('admin.branding.starPrompt')}
          help={t('admin.branding.starPromptHelp', { brand: DEFAULT_PRODUCT_NAME })}
          on={starPrompt}
          onChange={onStarPrompt}
        />
        <SupportSwitch
          label={t('admin.branding.showPoweredBy', { brand: DEFAULT_PRODUCT_NAME })}
          help={t('admin.branding.showPoweredByHelp')}
          on={poweredBy}
          onChange={onPoweredBy}
        />
      </div>
    </Card>
  )
}

/** How the logo next to the name (as at the top of emails) and a primary button look with the draft. */
function Preview({ draft, saved }: { draft: Draft; saved: Branding }) {
  const t = useT()
  const logo = draft.logo === undefined ? saved.logoUrl : draft.logo
  const color = parsedColor(draft.color) ?? DEFAULT_COLOR
  return (
    <section className="adm-brand-preview" aria-label={t('admin.branding.preview')}>
      <div className="ws">
        <span className={logo ? 'ws-mark is-logo' : 'ws-mark'} aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <LogoMark />}
        </span>
        <b>{draft.name.trim() || DEFAULT_PRODUCT_NAME}</b>
      </div>
      <span className="k-btn k-btn-sm adm-brand-sample" style={{ background: color, color: readableOn(color) }}>
        {t('admin.branding.sampleButton')}
      </span>
    </section>
  )
}

/** What is wrong with a product name, or null: the server refuses the same (brandingInput). */
export function nameProblem(name: string): MessageKey | null {
  if (!name.trim()) return msg('admin.branding.nameRequired')
  if (NAME_CONTROL_CHARACTERS.test(name)) return msg('admin.branding.nameCharacters')
  return null
}

export function BrandingSettings() {
  const t = useT()
  const saved = useBrand()
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved))
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [askingToKeep, setAskingToKeep] = useState(false)
  const dirty = isDirty(draft, saved)
  const nameKey = nameProblem(draft.name)
  const nameError = nameKey && t(nameKey)
  const invalid = Boolean(nameError) || parsedColor(draft.color) === undefined
  const update = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!dirty || invalid) return
    setSaving(true)
    setProblem(null)
    const input: BrandingInput = {
      name: draft.name.trim(),
      color: parsedColor(draft.color) ?? null,
      starPrompt: draft.starPrompt,
      poweredBy: draft.poweredBy,
    }
    if (draft.logo !== undefined) input.logo = draft.logo
    try {
      const next = { ...DEFAULT_BRANDING, ...(await runAdmin('branding.set', input)) } as Branding
      setBrand(next)
      setDraft(draftOf(next))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : t('admin.branding.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setDraft(draftOf(saved))
    setProblem(null)
  }

  return (
    <>
      <form className="adm-brand-form" onSubmit={save} onKeyDown={e => onSaveKey(e, dirty && !invalid && !saving)}>
        <Card
          title={t('admin.branding.cardTitle')}
          help={t('admin.branding.cardHelp', { brand: DEFAULT_PRODUCT_NAME })}
        >
          <Preview draft={draft} saved={saved} />
          <FormField id="brand-name" label={t('admin.branding.name')} error={nameError}>
            <Input
              id="brand-name"
              value={draft.name}
              maxLength={40}
              placeholder={DEFAULT_PRODUCT_NAME}
              invalid={Boolean(nameError)}
              onChange={e => update({ name: e.target.value })}
            />
          </FormField>
          <LogoField draft={draft} saved={saved} onChange={logo => update({ logo })} />
          <ColorField text={draft.color} onChange={color => update({ color })} />
        </Card>
        <SupportCard
          starPrompt={draft.starPrompt}
          poweredBy={draft.poweredBy}
          onStarPrompt={starPrompt => update({ starPrompt })}
          onPoweredBy={on => (on ? update({ poweredBy: true }) : setAskingToKeep(true))}
        />
        {problem && <FormMessage>{problem}</FormMessage>}
        <SaveBar dirty={dirty} saving={saving} onCancel={cancel} disabled={invalid} />
      </form>
      {askingToKeep && (
        <KeepPoweredByDialog
          onKeep={() => setAskingToKeep(false)}
          onHide={() => {
            setAskingToKeep(false)
            update({ poweredBy: false })
          }}
        />
      )}
    </>
  )
}
