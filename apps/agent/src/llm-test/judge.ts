// The LLM judge of the test suite (LIN-391): reads one transcript with the case's rubric ("must" and "must not"
// lines) and answers {pass, reasons} as JSON. Used for what a regex cannot tell (did it offer a message, did it stay
// polite, did it answer the question). The deterministic checks (checks.ts) come first; the judge adds to them.
import type { Transcript } from './conversation.ts'
import type { Model } from './model.ts'

export type Rubric = { must?: string[]; mustNot?: string[] }
export type Verdict = { pass: boolean; reasons: string[] }

/** The call as the judge reads it: who said what, with the tools the assistant used and what they returned. */
export function transcriptText(t: Transcript): string {
  return t.events
    .map(e => {
      switch (e.kind) {
        case 'caller':
          return `CALLER: ${e.text}`
        case 'assistant':
          return `ASSISTANT: ${e.text}`
        case 'line':
          return `ASSISTANT (fixed line, ${e.why}): ${e.text}`
        case 'tool':
          return `  [tool ${e.name}(${e.raw || ''}) -> ${e.result.replace(/\s+/g, ' ').slice(0, 300)}]`
        case 'note':
          return `  [${e.text}]`
      }
    })
    .join('\n')
}

export function judgePrompt(setup: string[], rubric: Rubric, t: Transcript): string {
  return [
    'You grade one phone call between an AI phone assistant and a caller, against a rubric. Be strict but fair: grade what the assistant actually said and did, not what it might have meant.',
    'Lines marked "fixed line" are said by the system, not chosen by the assistant. Lines in [brackets] are tool calls and their results, which the caller does not hear.',
    'Fail a run only for a rubric line it breaks; do not add requirements of your own, and read each line as written ("a or b" is met by either one). What the setup says is known (a saved contact\'s name, the caller ID number) need not be asked for. Each ASSISTANT line is one reply; a fixed line is not part of it.',
    'The transcript is a scripted part of a call and may stop before the call is over: a step the assistant has started counts (asking the first question toward a message is taking a message), as long as nothing it said or did breaks a line.',
    '',
    'Setup of this call:',
    ...setup.map(l => `- ${l}`),
    '',
    ...(rubric.must?.length ? ['The assistant MUST:', ...rubric.must.map(l => `- ${l}`)] : []),
    ...(rubric.mustNot?.length ? ['The assistant MUST NOT:', ...rubric.mustNot.map(l => `- ${l}`)] : []),
    '',
    'Transcript:',
    transcriptText(t),
    '',
    'Answer with a JSON object: {"pass": true|false, "reasons": ["..."]}. pass is true only if every MUST holds and no MUST NOT happens. In reasons, name each rule that failed and quote the line that broke it; when it passes, give one short reason.',
  ].join('\n')
}

export async function judge(model: Model, setup: string[], rubric: Rubric, t: Transcript): Promise<Verdict> {
  const content = await model.complete([{ role: 'user', content: judgePrompt(setup, rubric, t) }], {
    json: true,
    temperature: 0,
  })
  try {
    const parsed = JSON.parse(content) as { pass?: unknown; reasons?: unknown }
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : []
    return { pass: parsed.pass === true, reasons }
  } catch {
    return { pass: false, reasons: [`the judge did not answer JSON: ${content.slice(0, 200)}`] }
  }
}
