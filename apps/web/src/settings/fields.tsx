// Settings pages build on the kit's form pieces (ui/form.tsx); these keep the short names they use.
import { type ReactNode, useCallback, useState } from 'react'
import { T, useT } from '@linedesk/i18n/react'
import { appLink, LinkButton, plainTag } from '../ui/AppLink.tsx'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Card, FormField, Input, Textarea } from '../ui/form.tsx'
import { type HelpContent, HelpTip, helpContent } from '../ui/HelpTip.tsx'
import { Note } from '../ui/kit.tsx'
import { Skeleton, SkeletonFields } from '../ui/LoadStates.tsx'
import { useReadOnlySection } from './readOnly.ts'

type SectionProps = {
  id: string
  /** None: a card with only its fields, where the field labels say enough. */
  title?: string
  /** One short line. */
  description?: string
  /** Secondary detail, behind a (?) next to the title. */
  help?: HelpContent
  actions?: ReactNode
  children: ReactNode
}

export function Section({ id, title, description, help, actions, children }: SectionProps) {
  return (
    <Card id={id} className="st-sec" title={title} description={description} help={help} actions={actions}>
      {children}
    </Card>
  )
}

/**
 * For someone who can't change a section (a member, support access): one quiet note at its top, instead of the reason
 * under every field.
 */
export function ReadOnlyNote() {
  return <Note tone="info">{useReadOnlySection()}</Note>
}

type FieldProps = {
  id?: string
  label: string
  /** Muted line under the label, only when the label is not enough. */
  help?: ReactNode
  error?: string | null
  /** Next to the label, e.g. "Optional". */
  aside?: ReactNode
  /** Detail behind a (?) next to the label. */
  tip?: HelpContent
  /** Right after the label, outside it (e.g. the edit-business-hours icon). */
  labelAfter?: ReactNode
  children: ReactNode
}

export function Field({ id, label, help, error, aside, tip, labelAfter, children }: FieldProps) {
  return (
    <FormField id={id} label={label} description={help} error={error} aside={aside} help={tip} labelAfter={labelAfter}>
      {children}
    </FormField>
  )
}

type TextProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  invalid?: boolean
  disabled?: boolean
}

/** `size` as on Input: "sm" in a row of small selects and buttons (one height per row). */
export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  label,
  invalid,
  disabled,
  size,
}: TextProps & { size?: 'sm' | 'md' }) {
  return (
    <Input
      id={id}
      size={size}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      invalid={invalid}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
    />
  )
}

export function TextArea({ id, value, onChange, placeholder, label, tall, invalid }: TextProps & { tall?: boolean }) {
  return (
    <Textarea
      id={id}
      className={tall ? 'ta-tall' : undefined}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      invalid={invalid}
      onChange={e => onChange(e.target.value)}
    />
  )
}

type SwitchRowProps = {
  title: string
  description?: string
  /** A quiet line under the description: where the value comes from (FollowsLine). */
  note?: ReactNode
  /** Quiet note next to the title, e.g. "Team default". */
  aside?: string
  /** Detail behind a (?) next to the title. */
  help?: HelpContent
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  /** Greyed out: it has no effect yet (browser notifications before the browser allows them). */
  dimmed?: boolean
  /** An option of the row above: indented under it, without the line between them. */
  nested?: boolean
  /** The switch's hover tooltip. */
  tip?: string
}

export function SwitchRow({
  title,
  description,
  note,
  aside,
  help,
  on,
  onChange,
  disabled,
  dimmed,
  nested,
  tip,
}: SwitchRowProps) {
  const className = ['swrow', dimmed && 'is-dimmed', nested && 'is-nested'].filter(Boolean).join(' ')
  return (
    <div className={className}>
      <div>
        <b>
          {title}
          {help && <HelpTip {...helpContent(help)} />}
          {aside && <span className="swrow-aside">{aside}</span>}
        </b>
        {description && <span className="help">{description}</span>}
        {note}
      </div>
      <Switch on={on} onChange={onChange} label={title} disabled={disabled} title={tip} />
    </div>
  )
}

/**
 * A settings card whose title is not known yet (a whole section waits for data): the card itself, a short
 * grey title and `fields` labelled controls, each as tall as a Field with its input.
 */
export function SkeletonSection({ fields = 2 }: { fields?: number }) {
  return (
    <Card className="st-sec">
      <Skeleton shape="title" />
      <SkeletonFields fields={fields} />
    </Card>
  )
}

/**
 * A SelectRow whose value is not read yet: its title at once (words that don't need the data), the description's line
 * and the dropdown as grey shapes, the same height as the row that comes.
 */
export function SkeletonSelectRow({ title, description = true }: { title: ReactNode; description?: boolean }) {
  return (
    <div className="selrow">
      <div className="selrow-text">
        <b>{title}</b>
        {description && <Skeleton shape="text" width={260} />}
      </div>
      <Skeleton width={150} height={28} />
    </div>
  )
}

/** SwitchRows while they load (ui/LoadStates.tsx): the same rows and gaps, the switch a grey pill. */
export function SkeletonSwitchRows({ rows = 2, description = true }: { rows?: number; description?: boolean }) {
  return (
    <div className="st-swlist" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <div key={i} className="swrow">
          <div>
            <Skeleton shape="text" width={120 + ((i * 37) % 60)} />
            {description && <Skeleton shape="text" width={220 + ((i * 53) % 90)} />}
          </div>
          <Skeleton width={34} height={20} className="sk-round" />
        </div>
      ))}
    </div>
  )
}

/** An open/closed state (an Advanced disclosure) remembered in this browser; works without storage too. */
export function useRemembered(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const remember = useCallback(
    (next: boolean) => {
      setOpen(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Storage blocked: it is just not remembered.
      }
    },
    [key],
  )
  return [open, remember]
}

type SelectRowProps<T extends string> = {
  id: string
  title: string
  description?: string
  /** More about the setting: a "?" next to the title. */
  help?: HelpContent
  /** A quiet line under the description (e.g. what callers hear). */
  note?: ReactNode
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
}

/** Like SwitchRow, with a dropdown at the right; on a phone the dropdown goes under the text. */
export function SelectRow<T extends string>({
  id,
  title,
  description,
  help,
  note,
  value,
  options,
  onChange,
}: SelectRowProps<T>) {
  return (
    <div className="selrow">
      <div className="selrow-text">
        <b>
          {title}
          {help && <HelpTip {...helpContent(help)} />}
        </b>
        {description && <span className="help">{description}</span>}
        {note && <span className="help selrow-note">{note}</span>}
      </div>
      <Select id={id} size="sm" align="end" value={value} options={options} onChange={onChange} label={title} />
    </div>
  )
}

/** What a setting that follows another one follows: the workspace's country, or the team's default. */
export type FollowsSource = { kind: 'country'; country: string } | { kind: 'team' }

type FollowsLineProps = {
  source: FollowsSource
  /** The value follows its source now; false: set by hand. */
  follows: boolean
  /** What the source gives now: the country's ("Eastern Time"), or the team default ('on' or 'off'). */
  sourceDefault: string
  /** The line names what follows, for a field of more than one part (the appointment value's currency). */
  what?: 'currency'
  /** Where the source is set, when that is another place this viewer can open; else its name is plain words. */
  link?: string | null
  /** Goes back to following; none: the viewer can't change it, and the line says what the default is instead. */
  onReset?: () => void
  /** In a SwitchRow: a span under its description. */
  inline?: boolean
  /** The field's control: it gets the focus after the reset (the reset button itself goes away). */
  controlId?: string
}

/**
 * The one line for every setting whose value comes from another setting until someone sets it by hand
 * (docs/design-principles.md, help text): "From your workspace country (United States). Changes when the country
 * changes." while it follows; "Set by hand · Use country default (Eastern Time)" once set, the reset one click.
 * Under the field, in the muted helper style, never a badge or a colour.
 */
export function FollowsLine({
  source,
  follows,
  sourceDefault,
  what,
  link,
  onReset,
  inline,
  controlId,
}: FollowsLineProps) {
  const t = useT()
  const reset = () => {
    onReset?.()
    if (controlId) setTimeout(() => document.getElementById(controlId)?.focus(), 0)
  }
  const tag = link ? appLink(link) : plainTag
  const country = source.kind === 'country'
  const body = follows ? (
    country ? (
      <T k="settings.follows.country" values={{ what: what ?? 'value', country: source.country, link: tag }} />
    ) : (
      <T k="settings.follows.team" values={{ link: tag }} />
    )
  ) : (
    <>
      {t('settings.follows.setByHand', { what: what ?? 'value' })}
      <span aria-hidden="true"> · </span>
      {onReset ? (
        <LinkButton onClick={reset}>
          {country
            ? t('settings.follows.useCountry', { value: sourceDefault })
            : t('settings.follows.useTeam', { value: sourceDefault })}
        </LinkButton>
      ) : country ? (
        t('settings.follows.countryDefault', { value: sourceDefault })
      ) : (
        t('settings.follows.teamDefault', { value: sourceDefault })
      )}
    </>
  )
  return inline ? (
    <span className="help follows-line">{body}</span>
  ) : (
    <p className="k-field-desc follows-line">{body}</p>
  )
}
