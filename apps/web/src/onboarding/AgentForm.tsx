// An agent's steps (AgentSteps: the open link, numbered steps, a value to copy, the prompt), an AI client's own form
// drawn filled in (ChatGPT's Add custom MCP server), and the number of a step. Shared by the agent setup page
// (StartAgent: the setup link) and Settings › Integrations › MCP (connecting an agent for everyday use), so both look
// and work the same.
import type { StartForm, StartPlan, StartStep } from '@linedesk/actions'
import { useState } from 'react'
import { useT } from '@linedesk/i18n/react'
import { ClientLink } from '../ui/ClientLink.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { CopyButton } from './Frame.tsx'
import './agent-form.css'

/**
 * How to start or connect the chosen agent (a StartPlan). Where one link opens the agent (`open`), that button comes
 * first and the rest waits behind a quiet "Or …" (opened on request). Elsewhere the steps are the way: a command or
 * link, numbered when they follow one after the other, the prompt to copy where pasting it is.
 */
export function AgentSteps({ plan }: { plan: StartPlan }) {
  const t = useT()
  const { open, otherWay, steps, prompt, promptFirst, numbered } = plan
  const promptToCopy = (primary: boolean) => (
    <>
      <pre className="as-prompt">{prompt}</pre>
      <div>
        <CopyButton
          text={prompt}
          label={t('onboarding.agentSetup.copyPrompt')}
          variant={primary ? 'primary' : 'secondary'}
        />
      </div>
    </>
  )
  // The first copy or link is the main action, unless the open link above already is.
  const lead = (i: number) => !open && i === 0
  const body = (step: StartStep, i: number) => (
    <>
      {/* A step whose one action is a link: the button beside its text (below it on a narrow screen). */}
      {step.link && !step.code ? (
        <div className="as-step-inline">
          <span>{step.text}</span>
          <ClientLink
            href={step.link.href}
            label={step.link.label}
            title={step.link.title}
            variant={lead(i) ? 'primary' : 'secondary'}
          />
        </div>
      ) : (
        <span>{step.text}</span>
      )}
      {step.code && (
        <div className="as-code">
          <code>{step.code}</code>
          <CopyButton text={step.code} variant={lead(i) ? 'primary' : 'secondary'} />
        </div>
      )}
      {step.link && step.code && (
        <div>
          <ClientLink
            href={step.link.href}
            label={step.link.label}
            title={step.link.title}
            variant={lead(i) ? 'primary' : 'secondary'}
          />
        </div>
      )}
      {step.form && <AgentForm form={step.form} />}
      {step.prompt && <FoldedPrompt prompt={prompt} />}
    </>
  )
  // Only for when the step before did not work as expected: folded away below it.
  const fallback = (step: StartStep, i: number) => (
    <details key={step.text} className="as-other-way as-fallback">
      <summary>{step.summary ?? step.text}</summary>
      <div className="as-other-way-body">
        {step.summary && <span>{step.text}</span>}
        {step.code && (
          <div className="as-code">
            <code>{step.code}</code>
            <CopyButton text={step.code} variant={lead(i) ? 'primary' : 'secondary'} />
          </div>
        )}
      </div>
    </details>
  )
  // Steps done one after the other get their number (1, 2, 3), a fallback goes inside the step it belongs to.
  const stepList = numbered ? (
    <ol className="as-steps">
      {steps.map((step, i) =>
        step.fallback ? null : (
          <li key={step.text} className="as-step-numbered">
            <StepNumber n={steps.slice(0, i + 1).filter(s => !s.fallback).length} />
            <div className="as-step">
              {body(step, i)}
              {steps[i + 1]?.fallback && fallback(steps[i + 1]!, i + 1)}
            </div>
          </li>
        ),
      )}
    </ol>
  ) : (
    steps.map((step, i) =>
      step.fallback ? (
        fallback(step, i)
      ) : (
        <div key={step.text} className="as-step">
          {body(step, i)}
        </div>
      ),
    )
  )
  if (!open)
    return (
      <>
        {stepList}
        {/* The prompt to copy leads, unless the first step already has the main button (ChatGPT's settings). */}
        {promptFirst && <div className="as-step">{promptToCopy(!steps[0]?.link && !steps[0]?.code)}</div>}
      </>
    )
  return (
    <div className="as-start">
      <div className="as-open">
        <ClientLink href={open.href} label={open.label} title={open.title} variant="primary" size="md" />
        <span className="as-small">{open.text}</span>
      </div>
      <details className="as-other-way">
        <summary>{otherWay}</summary>
        <div className="as-other-way-body">{stepList}</div>
      </details>
    </div>
  )
}

/**
 * The prompt inside a step (ChatGPT's last step, Cursor's other way): Copy prompt is the action, the text itself stays
 * folded behind "Show prompt", so the steps fit on one screen before the agent connects.
 */
function FoldedPrompt({ prompt }: { prompt: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="as-prompt-row">
        <CopyButton text={prompt} label={t('onboarding.agentSetup.copyPrompt')} variant="secondary" />
        <Button
          size="sm"
          variant="ghost"
          className="as-fold"
          title={t(open ? 'onboarding.agentSetup.hidePromptTitle' : 'onboarding.agentSetup.showPromptTitle')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? 'onboarding.agentSetup.hidePrompt' : 'onboarding.agentSetup.showPrompt')}{' '}
          <Icon name={open ? 'up' : 'down'} size={14} />
        </Button>
      </div>
      {open && <pre className="as-prompt">{prompt}</pre>}
    </>
  )
}

/**
 * The agent's own form (ChatGPT's Add custom MCP server), drawn filled in: each field with the value to copy or the
 * option to pick, the checkbox ticked and the button that ends it, so the person sees where each value goes. Dense:
 * one line per field (label beside the value; a long value is cut short on screen, Copy and its tooltip have all of it),
 * the checkbox and the button on one line, so the steps fit on one screen.
 */
export function AgentForm({ form }: { form: StartForm }) {
  return (
    <div className="as-form">
      <div className="as-form-title">{form.title}</div>
      <div className="as-form-fields">
        {form.fields.map(field => (
          <div key={field.label} className="as-form-field">
            <span className="as-form-label">{field.label}</span>
            {field.copy ? (
              <div className="as-code as-code-line">
                <code title={field.value}>{field.value}</code>
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
      </div>
      <div className="as-form-submit">
        {form.check && (
          <span className="as-form-check">
            <span className="as-form-box" aria-hidden="true">
              <Icon name="check" size={12} />
            </span>
            {form.check}
          </span>
        )}
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
