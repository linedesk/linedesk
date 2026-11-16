// The model behind a simulated call (LIN-391): an OpenAI-compatible chat completions API, called the way the call's
// LLM is (LiveKit's OpenAI plugin with replyRequestFields: parallel tool calls, the reply cap, OpenRouter fallbacks).
// Counts tokens per model for the cost line of the report. Keys never leave this module (no logging).
import { defaultReasoningEffort } from '@livekit/agents-plugin-openai'
import { replyRequestFields } from '../pipeline.ts'
import type { OpenAiTool } from './tools.ts'

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }

export type ModelConfig = { baseUrl: string; apiKey: string; model: string; fallbacks?: string[] }

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }

export type UsageTotals = Record<string, { calls: number; input: number; cachedInput: number; output: number }>

/** USD per million tokens (input, cached input, output); a model not listed is reported without a price. */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
}

export function costOf(totals: UsageTotals): number | null {
  let sum = 0
  for (const [model, t] of Object.entries(totals)) {
    const price = PRICES[model.replace(/^openai\//, '')]
    if (!price) return null
    sum += ((t.input - t.cachedInput) * price.input + t.cachedInput * price.cached + t.output * price.output) / 1e6
  }
  return sum
}

export class ModelError extends Error {}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function createModel(config: ModelConfig, usage: UsageTotals) {
  const count = (model: string, u: Usage | undefined) => {
    usage[model] ??= { calls: 0, input: 0, cachedInput: 0, output: 0 }
    const t = usage[model]
    t.calls++
    t.input += u?.prompt_tokens ?? 0
    t.cachedInput += u?.prompt_tokens_details?.cached_tokens ?? 0
    t.output += u?.completion_tokens ?? 0
  }

  async function post(
    body: Record<string, unknown>,
  ): Promise<{ message: { content: string | null; tool_calls?: ToolCall[] } }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }) as const)
      if (res.ok) {
        const json = (await (res as Response).json()) as {
          choices?: { message: { content: string | null; tool_calls?: ToolCall[] } }[]
          usage?: Usage
        }
        count(String(body.model), json.usage)
        const message = json.choices?.[0]?.message
        if (!message) throw new ModelError('the model returned no choice')
        return { message }
      }
      const retry = res.status === 0 || res.status === 429 || res.status >= 500
      if (!retry || attempt >= 5) {
        const text = (await res.text()).slice(0, 300)
        throw new ModelError(`chat completions failed (${res.status}): ${text}`)
      }
      await sleep(1000 * 2 ** attempt + Math.random() * 500)
    }
  }

  return {
    model: config.model,
    /** One reply of the assistant, as the call's LLM is asked for it. `toolsOff`: the last round of a turn (MAX_TOOL_STEPS). */
    reply(messages: ChatMessage[], tools: OpenAiTool[], { toolsOff = false } = {}) {
      const effort = defaultReasoningEffort(config.model)
      return post({
        model: config.model,
        messages,
        ...(tools.length ? { tools, parallel_tool_calls: true, ...(toolsOff ? { tool_choice: 'none' } : {}) } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
        ...replyRequestFields(config.model, config.fallbacks ?? []),
      })
    },
    /** A plain completion (the simulated caller, the judge); `json`: ask for a JSON object. */
    async complete(
      messages: ChatMessage[],
      { json = false, temperature }: { json?: boolean; temperature?: number } = {},
    ) {
      const { message } = await post({
        model: config.model,
        messages,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      })
      return message.content ?? ''
    },
  }
}

export type Model = ReturnType<typeof createModel>
