// Small form pieces for settings pages. Class names match the reference UI.
import type { ReactNode } from 'react'
import { Button, Icon } from '../ui/kit.tsx'

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

export function TextArea({ id, value, onChange, placeholder, label, small }: TextProps & { small?: boolean }) {
  return <textarea id={id} className={small ? 'ta st-ta-sm' : 'ta'} value={value} placeholder={placeholder} aria-label={label} onChange={e => onChange(e.target.value)} />
}

export function SwitchRow({ title, description, on, onChange }: { title: string; description: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="swrow">
      <div><b>{title}</b><span className="help">{description}</span></div>
      <button type="button" role="switch" className="sw" aria-checked={on} aria-label={title} onClick={() => onChange(!on)} />
    </div>
  )
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" className="st-rm" aria-label={label} title={label} onClick={onClick}><Icon name="trash" size={14} /></Button>
}

export const replaceAt = <T,>(list: T[], index: number, item: T) => list.map((x, i) => (i === index ? item : x))
export const without = <T,>(list: T[], index: number) => list.filter((_, i) => i !== index)
