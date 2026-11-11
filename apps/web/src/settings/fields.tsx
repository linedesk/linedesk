// Settings pages build on the kit's form pieces (ui/form.tsx); these keep the short names they use.
import type { ReactNode } from 'react'
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
  children: ReactNode
}

export function Field({ id, label, help, error, children }: FieldProps) {
  return (
    <FormField id={id} label={label} description={help} error={error}>
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
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}

export function SwitchRow({ title, description, on, onChange, disabled }: SwitchRowProps) {
  return (
    <div className="swrow">
      <div>
        <b>{title}</b>
        {description && <span className="help">{description}</span>}
      </div>
      <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
    </div>
  )
}
