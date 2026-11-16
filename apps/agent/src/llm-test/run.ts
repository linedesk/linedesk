// The LLM test suite's CLI (LIN-391): runs the cases of cases.ts against the install's configured LLM (or --model),
// grades every run with the deterministic checks and the judge, prints a table, writes report.json and report.md
// (with the transcripts of failed runs) to apps/agent/llm-test-results/<timestamp>/, and exits 1 when a case fails.
// It calls a paid model: run it by hand, not in CI. Usage: docs/commands.md ("LLM test suite").
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs as parseCli } from 'node:util'
import { createDb } from '@linedesk/db'
import { parseProviderSettings, resolveAgentConfig } from '../config.ts'
import { CASES, CATEGORIES, type Case, neededPasses } from './cases.ts'
import { describeCheck, globalProblems, runCheck } from './checks.ts'
import { runCall, type Transcript } from './conversation.ts'
import { judge, transcriptText } from './judge.ts'
import { costOf, createModel, type ModelConfig, type UsageTotals } from './model.ts'

const HELP = `pnpm --filter @linedesk/agent llm-test [options]

  --case <id,...>        only these cases (prefix match: --case booking- runs every booking case)
  --category <name,...>  only these categories (${CATEGORIES.join(', ')})
  --runs <n>             runs per case (default 3)
  --concurrency <n>      calls at the same time (default 6)
  --model <id>           the assistant's model (default: the install's LLM)
  --judge-model <id>     the judge's and the simulated caller's model (default: gpt-4.1 on OpenAI, else --model)
  --no-judge             only the deterministic checks
  --list                 list the cases and exit
`

type RunResult = { run: number; pass: boolean; reasons: string[]; transcript: Transcript | null }
type CaseResult = { case: Case; runs: RunResult[]; passes: number; needed: number; pass: boolean }

function pickCases(caseIds: string[], categories: string[]): Case[] {
  return CASES.filter(
    c =>
      (!caseIds.length || caseIds.some(id => c.id === id || (id.endsWith('-') && c.id.startsWith(id)))) &&
      (!categories.length || categories.includes(c.category)),
  )
}

/** The install's database: DATABASE_URL, else the compose Postgres on its host port (pnpm db:up, the dev-mode stack). */
function databaseUrl(): string | null {
  const env = process.env
  if (env.DATABASE_URL) return env.DATABASE_URL
  if (!env.POSTGRES_PASSWORD) return null
  const user = encodeURIComponent(env.POSTGRES_USER || 'linedesk')
  return `postgres://${user}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:${env.POSTGRES_PORT || '5433'}/${env.POSTGRES_DB || 'linedesk'}`
}

/** The install's LLM, as the agent resolves it: provider settings from the database (keys decrypted), then the env. */
async function installModel(): Promise<ModelConfig & { provider: string }> {
  const url = databaseUrl()
  if (!url)
    throw new Error(
      'DATABASE_URL (or POSTGRES_PASSWORD) is not set: run with the .env of the install; see docs/commands.md',
    )
  const { db, pool } = createDb(url)
  try {
    // A URL import, so the agent's typecheck does not follow into the API's sources.
    const settings = await import(new URL('../../../api/src/provider-settings.ts', import.meta.url).href)
    const config = resolveAgentConfig(parseProviderSettings(await settings.voiceProviderConfig(db)))
    if (!config.llm.apiKey) throw new Error('no LLM key is set for this install (Admin, Providers)')
    return {
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl.replace(/\/$/, ''),
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      fallbacks: config.llm.fallbacks,
    }
  } finally {
    await pool.end()
  }
}

async function pool<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await items[i]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`

function markdownReport(results: CaseResult[], meta: Record<string, unknown>): string {
  const failed = results.filter(r => !r.pass)
  const lines = [
    `# LLM test suite: ${results.length - failed.length}/${results.length} cases pass`,
    '',
    ...Object.entries(meta).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`),
    '',
    '| Case | Category | Severity | Passed | Result |',
    '| --- | --- | --- | --- | --- |',
    ...results.map(
      r =>
        `| ${r.case.id} | ${r.case.category} | ${r.case.severity} | ${r.passes}/${r.runs.length} | ${r.pass ? 'pass' : '**FAIL**'} |`,
    ),
    '',
  ]
  for (const r of results.filter(x => x.runs.some(run => !run.pass))) {
    lines.push(
      `## ${r.case.id}: ${r.case.title} (${r.pass ? 'passes' : 'FAILS'}, ${r.passes}/${r.runs.length})`,
      '',
      `Rule: ${r.case.why}`,
      '',
    )
    for (const run of r.runs.filter(x => !x.pass)) {
      lines.push(
        `### Run ${run.run}`,
        '',
        ...run.reasons.map(reason => `- ${reason}`),
        '',
        '```',
        run.transcript ? transcriptText(run.transcript) : '(no transcript)',
        '```',
        '',
      )
    }
  }
  return lines.join('\n')
}

async function main() {
  const { values } = parseCli({
    options: {
      case: { type: 'string' },
      category: { type: 'string' },
      runs: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '6' },
      model: { type: 'string' },
      'judge-model': { type: 'string' },
      'no-judge': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) return void process.stdout.write(HELP)
  const split = (v?: string) =>
    v
      ? v
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : []
  const cases = pickCases(split(values.case), split(values.category))
  if (values.list) {
    for (const c of cases) console.log(`${c.id.padEnd(36)} ${c.category.padEnd(10)} ${c.severity.padEnd(6)} ${c.title}`)
    console.log(`${cases.length} cases`)
    return
  }
  if (!cases.length) throw new Error('no case matches --case / --category')
  const runs = Math.max(1, Number(values.runs) || 3)
  const install = await installModel()
  const assistantConfig: ModelConfig = {
    ...install,
    model: values.model ?? install.model,
    fallbacks: values.model ? [] : install.fallbacks,
  }
  const judgeModelId = values['judge-model'] ?? (install.provider === 'openai' ? 'gpt-4.1' : assistantConfig.model)
  const usage: UsageTotals = {}
  const model = createModel(assistantConfig, usage)
  const judgeModel = createModel({ ...install, model: judgeModelId, fallbacks: [] }, usage)
  console.log(`${cases.length} cases x ${runs} runs on ${assistantConfig.model} (judge and caller: ${judgeModelId})`)

  let done = 0
  const total = cases.length * runs
  const jobs = cases.flatMap(c =>
    Array.from({ length: runs }, (_, i) => async (): Promise<[string, RunResult]> => {
      let result: RunResult
      try {
        const transcript = await runCall(
          c.setup,
          { turns: c.turns, caller: c.caller },
          { model, callerModel: judgeModel, sim: c.sim },
        )
        const reasons = [
          ...c.checks.flatMap(check => {
            const failed = runCheck(check, transcript)
            return failed ? [`check ${describeCheck(check)}: ${failed}`] : []
          }),
          ...globalProblems(transcript),
        ]
        if (c.judge && !values['no-judge']) {
          const verdict = await judge(judgeModel, c.setup.description, c.judge, transcript)
          if (!verdict.pass) reasons.push(...verdict.reasons.map(r => `judge: ${r}`))
        }
        result = { run: i + 1, pass: reasons.length === 0, reasons, transcript }
      } catch (e) {
        result = {
          run: i + 1,
          pass: false,
          reasons: [`error: ${e instanceof Error ? e.message : String(e)}`],
          transcript: null,
        }
      }
      done++
      if (done % Math.max(1, Math.round(total / 4)) === 0 || done === total) console.log(`  ${done}/${total} runs`)
      return [c.id, result]
    }),
  )
  const outcomes = await pool(jobs, Math.max(1, Number(values.concurrency) || 6))

  const results: CaseResult[] = cases.map(c => {
    const caseRuns = outcomes.filter(([id]) => id === c.id).map(([, r]) => r)
    const passes = caseRuns.filter(r => r.pass).length
    const needed = neededPasses(c.severity, runs)
    return { case: c, runs: caseRuns, passes, needed, pass: passes >= needed }
  })

  const cost = costOf(usage)
  let commit = 'unknown'
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {}
  const meta = {
    date: new Date().toISOString(),
    commit,
    model: assistantConfig.model,
    judgeModel: judgeModelId,
    runs,
    usage,
    costUsd: cost === null ? 'unknown (a model without a price)' : Number(cost.toFixed(3)),
  }

  console.log('')
  console.table(
    results.map(r => ({
      case: r.case.id,
      category: r.case.category,
      severity: r.case.severity,
      passed: `${r.passes}/${runs}`,
      result: r.pass ? 'pass' : 'FAIL',
    })),
  )
  const byCategory = CATEGORIES.map(cat => {
    const rs = results.filter(r => r.case.category === cat)
    return rs.length ? `${cat} ${rs.filter(r => r.pass).length}/${rs.length}` : null
  }).filter(Boolean)
  const failed = results.filter(r => !r.pass)
  const runPasses = results.reduce((n, r) => n + r.passes, 0)
  console.log(`\nCategories: ${byCategory.join(', ')}`)
  console.log(
    `Cases: ${results.length - failed.length}/${results.length} pass; runs: ${runPasses}/${total} (${pct(runPasses, total)})`,
  )
  for (const r of failed)
    console.log(
      `FAIL ${r.case.id} (${r.passes}/${runs}, needs ${r.needed}): ${r.runs.find(x => !x.pass)?.reasons[0] ?? ''}`,
    )
  console.log(`Cost: ${cost === null ? 'unknown' : `$${cost.toFixed(2)}`}`)

  const dir = join(import.meta.dirname, '..', '..', 'llm-test-results', meta.date.replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const json = results.map(r => ({
    id: r.case.id,
    category: r.case.category,
    title: r.case.title,
    why: r.case.why,
    severity: r.case.severity,
    passes: r.passes,
    runs: r.runs.length,
    needed: r.needed,
    pass: r.pass,
    failures: r.runs
      .filter(x => !x.pass)
      .map(x => ({ run: x.run, reasons: x.reasons, transcript: x.transcript?.events ?? null })),
  }))
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify({ meta, cases: json }, null, 2)}\n`)
  writeFileSync(join(dir, 'report.md'), markdownReport(results, meta))
  // The system prompt of each failed case, to read the failure against.
  for (const r of failed) {
    const t = r.runs.find(x => x.transcript)?.transcript
    if (t) {
      mkdirSync(join(dir, 'prompts'), { recursive: true })
      writeFileSync(join(dir, 'prompts', `${r.case.id}.txt`), t.instructions)
    }
  }
  console.log(`Report: ${dir}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 2
})
