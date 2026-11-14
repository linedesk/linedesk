// Settings pages build on the kit's form pieces (ui/form.tsx); these keep the short names they use.
import { type ReactNode, useCallback, useState } from 'react'
import { Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Card, FormField, Input, Textarea } from '../ui/form.tsx'
import { type HelpContent, HelpTip, helpContent } from '../ui/HelpTip.tsx'
import { Skeleton, SkeletonFields } from '../ui/LoadStates.tsx'

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

type FieldProps = {
  id?: string
  label: string
  /** Muted line under the label, only when the label is not enough. */
  help?: string
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
}

/** `size` as on Input: "sm" in a row of small selects and buttons (one height per row). */
export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  label,
  invalid,
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
  /** Quiet note next to the title, e.g. "Team default". */
  aside?: string
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  /** Greyed out: it has no effect yet (browser notifications before the browser allows them). */
  dimmed?: boolean
  /** An option of the row above: indented under it, without the line between them. */
  nested?: boolean
}

export function SwitchRow({ title, description, aside, on, onChange, disabled, dimmed, nested }: SwitchRowProps) {
  const className = ['swrow', dimmed && 'is-dimmed', nested && 'is-nested'].filter(Boolean).join(' ')
  return (
    <div className={className}>
      <div>
        <b>
          {title}
          {aside && <span className="swrow-aside">{aside}</span>}
        </b>
        {description && <span className="help">{description}</span>}
      </div>
      <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
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
