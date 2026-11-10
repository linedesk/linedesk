// Small form pieces for settings pages. Class names match the reference UI.
import type { ReactNode } from 'react'
import { Switch } from '../ui/controls.tsx'

export function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section id={id} className="sec st-sec" aria-labelledby={`${id}-h`}>
      <div className="st-sec-head"><div><h2 id={`${id}-h`}>{title}</h2><p>{description}</p></div></div>
      {children}
    </section>
  )
}

export function Field({ id, label, help, children }: { id?: string; label: string; help?: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{help && <span className="help">{help}</span>}{children}</div>
}

type TextProps = { id?: string; value: string; onChange: (value: string) => void; placeholder?: string; label?: string }

export function TextInput({ id, value, onChange, placeholder, label }: TextProps) {
  return <label className="k-input"><input id={id} value={value} placeholder={placeholder} aria-label={label} onChange={e => onChange(e.target.value)} /></label>
}

export function TextArea({ id, value, onChange, placeholder, label, tall }: TextProps & { tall?: boolean }) {
  return <textarea id={id} className={tall ? 'ta ta-tall' : 'ta'} value={value} placeholder={placeholder} aria-label={label} onChange={e => onChange(e.target.value)} />
}

export function SwitchRow({ title, description, on, onChange, disabled }: { title: string; description: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <div className="swrow">
      <div><b>{title}</b><span className="help">{description}</span></div>
      <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
    </div>
  )
}
