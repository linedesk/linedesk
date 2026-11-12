// Branding: the product name, logo and primary color of the whole install, for people who run their own
// server under their own name (packages/actions/src/branding.ts). Saved with branding.set; shown at once
// here and in this tab (setBrand), in other tabs and for other people on their next page load.
import {
  type Branding,
  type BrandingInput,
  DEFAULT_BRANDING,
  DEFAULT_PRODUCT_NAME,
  LOGO_MAX_BYTES,
  LOGO_SIZE,
  readableOn,
} from '@linedesk/actions'
import { type FormEvent, useRef, useState } from 'react'
import { setBrand, useBrand } from '../brand.ts'
import { Switch } from '../ui/controls.tsx'
import { Card, FormField, FormMessage, Input, onSaveKey, SaveBar } from '../ui/form.tsx'
import { Button, LogoMark } from '../ui/kit.tsx'
import { runAdmin } from './api.ts'

const DEFAULT_COLOR = '#1c1917'

const HEX = /^#[0-9a-fA-F]{6}$/

/** The color as typed: empty is the default (null), a #rrggbb color is used, anything else is not valid (undefined). */
const parsedColor = (text: string): string | null | undefined =>
  text === '' ? null : HEX.test(text) ? text.toLowerCase() : undefined

type Draft = {
  name: string
  /** As typed, see parsedColor. */
  color: string
  /** A new logo as a PNG data URL, null to remove it; undefined keeps the saved one. */
  logo: string | null | undefined
  starPrompt: boolean
}

const draftOf = (b: Branding): Draft => ({
  name: b.name,
  color: b.color ?? '',
  logo: undefined,
  starPrompt: b.starPrompt,
})

const isDirty = (d: Draft, b: Branding) =>
  d.name.trim() !== b.name || parsedColor(d.color) !== b.color || d.logo !== undefined || d.starPrompt !== b.starPrompt

/**
 * Any image the browser can show, drawn centred on a transparent square of at most LOGO_SIZE pixels and
 * saved as PNG: the server only ever stores and serves a plain PNG, never an SVG that could carry script.
 */
async function logoAsPng(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error('That file is not an image this browser can read. Use a PNG, JPEG, WebP or SVG.')
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
        `The logo is too large once converted: use a simpler image (at most ${LOGO_MAX_BYTES / 1024} KB).`,
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
  const fileRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const shown = draft.logo === undefined ? saved.logoUrl : draft.logo
  async function pick(file: File | undefined) {
    if (!file) return
    setProblem(null)
    try {
      onChange(await logoAsPng(file))
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not read that image.')
    }
  }
  return (
    <FormField
      id="brand-logo"
      label="Logo"
      description={`Square works best. Shown in the menu, on the sign-in page, as the browser and app icon and in emails. Saved as a PNG of at most ${LOGO_SIZE}×${LOGO_SIZE} pixels.`}
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
          {shown ? 'Replace' : 'Upload'}
        </Button>
        {shown && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(saved.logoUrl ? null : undefined)}
            title="Use the default mark"
          >
            Remove
          </Button>
        )}
      </div>
    </FormField>
  )
}

function ColorField({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const color = parsedColor(text)
  return (
    <FormField
      id="brand-color"
      label="Primary color"
      description="Buttons and other main actions. Text on it turns light or dark by itself."
      error={color === undefined ? 'Use a color like #1c1917.' : null}
    >
      <div className="adm-brand-color">
        <input
          type="color"
          aria-label="Pick a color"
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
            Default
          </Button>
        )}
      </div>
    </FormField>
  )
}

/** How the menu and a primary button look with the draft. */
function Preview({ draft, saved }: { draft: Draft; saved: Branding }) {
  const logo = draft.logo === undefined ? saved.logoUrl : draft.logo
  const color = parsedColor(draft.color) ?? DEFAULT_COLOR
  return (
    <section className="adm-brand-preview" aria-label="Preview">
      <div className="ws">
        <span className={logo ? 'ws-mark is-logo' : 'ws-mark'} aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <LogoMark />}
        </span>
        <b>{draft.name.trim() || DEFAULT_PRODUCT_NAME}</b>
      </div>
      <span className="k-btn k-btn-sm adm-brand-sample" style={{ background: color, color: readableOn(color) }}>
        Primary button
      </span>
    </section>
  )
}

export function BrandingSettings() {
  const saved = useBrand()
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved))
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const dirty = isDirty(draft, saved)
  const nameError = draft.name.trim() ? null : 'Give the product a name.'
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
    }
    if (draft.logo !== undefined) input.logo = draft.logo
    try {
      const next = { ...DEFAULT_BRANDING, ...(await runAdmin('branding.set', input)) } as Branding
      setBrand(next)
      setDraft(draftOf(next))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not save the branding.')
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setDraft(draftOf(saved))
    setProblem(null)
  }

  return (
    <form onSubmit={save} onKeyDown={e => onSaveKey(e, dirty && !invalid && !saving)}>
      <Card
        title="Name, logo and color"
        help={`Run this server under your own name: everyone using it sees this name, logo and color instead of ${DEFAULT_PRODUCT_NAME}, in the app, on the sign-in page, on the installed app and in emails.`}
      >
        <Preview draft={draft} saved={saved} />
        <FormField id="brand-name" label="Product name" error={nameError}>
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
        <div className="swrow">
          <div>
            <b>Ask members for a GitHub star</b>
            <p className="help">
              A one-time prompt after a few days of use that asks to star {DEFAULT_PRODUCT_NAME} on GitHub.
            </p>
          </div>
          <Switch
            on={draft.starPrompt}
            onChange={starPrompt => update({ starPrompt })}
            label="Ask members for a GitHub star"
          />
        </div>
        {problem && <FormMessage>{problem}</FormMessage>}
      </Card>
      <SaveBar dirty={dirty} saving={saving} onCancel={cancel} disabled={invalid} />
    </form>
  )
}
