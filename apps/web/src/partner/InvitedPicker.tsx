// Who of the people a white-label partner's team invited into a client workspace leaves with the team (security
// review of #1113, M-1): shown in both confirmations, the partner's hand-over and the client's Remove partner. Nobody
// is ticked at first; the client's owner and anyone who owned the workspace are never listed (the API leaves them out).
import type { PartnerInvitedMember } from '@linedesk/actions'
import { Checkbox } from '../ui/controls.tsx'

type Props = {
  people: PartnerInvitedMember[]
  /** The question above the list ("Also remove people your team invited?"). */
  legend: string
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  disabled?: boolean
}

export function InvitedPicker({ people, legend, selected, onChange, disabled }: Props) {
  if (!people.length) return null
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    onChange(next)
  }
  return (
    <fieldset className="k-check-list">
      <legend className="help">{legend}</legend>
      {people.map(p => (
        <Checkbox
          key={p.memberId}
          checked={selected.has(p.memberId)}
          disabled={disabled}
          onChange={on => toggle(p.memberId, on)}
        >
          {p.name && p.name !== p.email ? `${p.name} · ${p.email}` : p.email}
        </Checkbox>
      ))}
    </fieldset>
  )
}
