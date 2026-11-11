// Settings > Assistant > Emergencies: a view onto the transfer contacts that take urgent calls (edited
// under Calls & transfers) and what the assistant tells a caller with an emergency. Part of the draft.
import { EMERGENCY_NOTE_MAX, isEmergencyCondition } from '@linedesk/actions'
import { Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { canAddTransfer, type Draft, transferInactive } from './assistantDraft.ts'
import { Field, Section, TextArea } from './fields.tsx'

type Props = {
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  name: string
  hoursOn: boolean
  canEdit: boolean
  /** Opens a transfer contact (by index) under Calls & transfers. */
  onEdit: (index: number) => void
  onAdd: () => void
}

export function Emergencies({ draft, set, name, hoursOn, canEdit, onEdit, onAdd }: Props) {
  const contacts = draft.transfers.map((c, index) => ({ c, index })).filter(({ c }) => isEmergencyCondition(c.condition))
  const length = draft.emergency_note.trim().length
  return (
    <>
      <Section
        id="as-emergency"
        title="Who takes urgent calls"
        description="Transfer contacts whose condition is about urgent calls or emergencies."
        help={`${name} flags a call as urgent when someone or something is in danger: a burst pipe, flooding, a gas smell, no heat in freezing weather. It then puts the caller through to the first of these contacts who answers. Nobody answers, or there is no contact: ${name} takes a message marked urgent, so it is at the top of your inbox.`}
        actions={
          <Button size="sm" variant="ghost" icon="plus" disabled={!canAddTransfer(draft)} onClick={onAdd}>
            Add emergency contact
          </Button>
        }
      >
        {contacts.length ? (
          <List label="Emergency contacts">
            {contacts.map(({ c, index }) => {
              const inactive = transferInactive(c)
              return (
                <ListRow
                  key={c.id}
                  title={c.name || 'No name yet'}
                  sub={c.number || 'No number yet'}
                  off={!!inactive}
                  aside={
                    inactive || !(hoursOn && c.hours_only) ? (
                      <span className="help">{inactive ?? 'Any time'}</span>
                    ) : (
                      <span className="help bh-with">
                        Business hours only
                        <EditBusinessHours canEdit={canEdit} />
                      </span>
                    )
                  }
                  actions={
                    <Button size="sm" variant="ghost" onClick={() => onEdit(index)} title="Edit under Calls & transfers">
                      Edit
                    </Button>
                  }
                />
              )
            })}
          </List>
        ) : (
          <ListEmpty>No emergency contact: urgent calls become a message marked urgent.</ListEmpty>
        )}
      </Section>
      <Section
        id="as-emergency-note"
        title="What to tell callers"
        description="Safety advice or what happens next, said after the call is flagged urgent."
      >
        <Field id="as-emergency-text" label="In an emergency, tell the caller" aside="Optional">
          <TextArea
            id="as-emergency-text"
            value={draft.emergency_note}
            onChange={v => set('emergency_note', v)}
            placeholder={'If you smell gas, leave the building and call 911 from outside.\nTurn off the main water valve if you can do it safely.'}
            invalid={length > EMERGENCY_NOTE_MAX}
          />
          <span className="help">{length ? `${length.toLocaleString('en-US')} / ${EMERGENCY_NOTE_MAX.toLocaleString('en-US')}` : 'Empty: nothing extra.'}</span>
        </Field>
      </Section>
    </>
  )
}
