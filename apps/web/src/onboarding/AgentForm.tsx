// An AI client's own form drawn filled in (ChatGPT's Add custom MCP server), and the number of a step in a guide
// whose steps follow one after the other. Used by the agent setup page (StartAgent) and Settings › Integrations › MCP.
import type { StartForm } from '@linedesk/actions'
import { Icon } from '../ui/kit.tsx'
import { CopyButton } from './Frame.tsx'
import './agent-form.css'

/**
 * The agent's own form (ChatGPT's Add custom MCP server), drawn filled in: each field with the value to copy or the
 * option to pick, the checkbox ticked and the button that ends it, so the person sees where each value goes.
 */
export function AgentForm({ form }: { form: StartForm }) {
  return (
    <div className="as-form">
      <div className="as-form-title">{form.title}</div>
      {form.fields.map(field => (
        <div key={field.label} className="as-form-field">
          <span className="as-form-label">{field.label}</span>
          {field.copy ? (
            <div className="as-code">
              <code>{field.value}</code>
              <CopyButton text={field.value} />
            </div>
          ) : (
            <span className="as-form-pick">
              <span className="as-form-radio" aria-hidden="true" />
              {field.value}
            </span>
          )}
        </div>
      ))}
      {form.check && (
        <span className="as-form-check">
          <span className="as-form-box" aria-hidden="true">
            <Icon name="check" size={12} />
          </span>
          {form.check}
        </span>
      )}
      <div className="as-form-submit">
        <span className="as-form-button">{form.submit}</span>
      </div>
    </div>
  )
}

/** A step's number in a circle (1, 2, 3), beside the step; the list itself is an <ol> for screen readers. */
export function StepNumber({ n }: { n: number }) {
  return (
    <span className="as-step-number" aria-hidden="true">
      {n}
    </span>
  )
}
