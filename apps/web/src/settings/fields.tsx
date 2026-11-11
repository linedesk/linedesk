// Settings pages build on the kit's form pieces (ui/form.tsx); these keep the short names they use.
import { type ReactNode, useCallback, useState } from 'react'
import { Switch } from '../ui/controls.tsx'
import { Card, FormField, Input, Textarea } from '../ui/form.tsx'

type SectionProps = {
  id: string
  title: string
  /** One short line. */
  description?: string
  /** Secondary detail, behind a (?) next to the title. */
  help?: string
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
  tip?: string
  children: ReactNode
}

export function Field({ id, label, help, error, aside, tip, children }: FieldProps) {
  return (
    <FormField id={id} label={label} description={help} error={error} aside={aside} help={tip}>
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

export function TextInput({ id, value, onChange, placeholder, label, invalid }: TextProps) {
  return (
    <Input
      id={id}
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
}

export function SwitchRow({ title, description, aside, on, onChange, disabled }: SwitchRowProps) {
  return (
    <div className="swrow">
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
