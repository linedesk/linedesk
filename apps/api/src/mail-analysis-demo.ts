// Runs the support mail analysis (mail-analysis.ts) on the demo mailbox (packages/mail, Brightwater Plumbing's made-up
// support mail) and prints what the model found. Stores nothing and reads no real mailbox: a way to see the prompts at
// work. The model is the install's (Server admin › Providers), or another API with its key from the environment.
//   pnpm --filter @linedesk/api mail:demo [--months 6|12]
//   pnpm --filter @linedesk/api mail:demo --provider openrouter [--model openai/gpt-4.1-mini]   (OPENROUTER_API_KEY)
import { parseArgs } from 'node:util'
import { type LlmProvider, llmEndpoints, zeroDataRetentionOn } from '@linedesk/actions'
import { createDemoMail } from '@linedesk/mail'
import { db } from './db.ts'
import { chatJson, type EvaluationModel, evaluationModel } from './evaluations.ts'
import { analyzeConversations, MODEL_OPTIONS, supportConversations } from './mail-analysis.ts'

const KEY_ENV: Partial<Record<LlmProvider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
}

async function modelFrom(provider: string | undefined, model: string | undefined): Promise<EvaluationModel | null> {
  if (!provider) return evaluationModel(db, fetch, MODEL_OPTIONS)
  if (!(provider in llmEndpoints)) throw new Error(`unknown provider ${provider}`)
  const endpoint = llmEndpoints[provider as LlmProvider]
  const key = process.env[KEY_ENV[provider as LlmProvider] ?? '']
  if (!key) throw new Error(`set ${KEY_ENV[provider as LlmProvider]}`)
  const name = model ?? endpoint.models[0]
  const zdr = zeroDataRetentionOn(undefined)
  return {
    model: name,
    complete: chatJson(key, endpoint.baseUrl, name, fetch, { ...MODEL_OPTIONS, zeroDataRetention: zdr }),
  }
}

const { values } = parseArgs({
  options: { months: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } },
})
const months = Number(values.months ?? 12)
const after = new Date(Date.now() - months * 30.5 * 86_400_000).toISOString()
const model = await modelFrom(values.provider, values.model)
if (!model) {
  console.error('No language model: set one up under Server admin › Providers, or pass --provider with its key.')
  process.exit(1)
}
const { conversations, read } = await supportConversations(createDemoMail(), after)
console.error(`${read} conversations read, ${conversations.length} support conversations, model ${model.model}`)
const started = Date.now()
const { topics, covered } = await analyzeConversations(model, conversations)
console.error(`${((Date.now() - started) / 1000).toFixed(1)} s, the topics cover ${covered} of ${conversations.length}`)
console.log(JSON.stringify(topics, null, 2))
process.exit(0)
