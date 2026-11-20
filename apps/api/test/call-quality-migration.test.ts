// The data moves of migrations 0153 (call quality) and 0158 (everything back on Standard), replayed as the files stand
// (decision of 2026-11-18, security review H-1): every assistant on Standard with the level's default models, whatever
// it picked or the install's old pipeline policy said, and new assistants on Standard. 0158 does it again on installs
// that ran 0153 as it first was. `assistants.voice_pipeline` is gone since 0156, so the 0153 replay runs on temporary
// tables shaped as before 0156; the tables come first in the search path, in a transaction that is rolled back: nothing
// else sees them.
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'

/** The statements of a migration file, comments dropped. */
const statementsOf = (file: string) =>
  readFileSync(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), 'utf8')
    .split('--> statement-breakpoint')
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
const migration0153 = statementsOf('0153_call_quality.sql')
const updates0153 = migration0153.filter(s => s.startsWith('UPDATE'))
const settingsInsert = migration0153.filter(s => s.startsWith('INSERT INTO "instance_settings"'))
const migration0158 = statementsOf('0158_call_quality_standard.sql')

type Row = {
  id: string
  call_quality: string
  llm_model: string | null
  realtime_model: string | null
  voice: Record<string, string>
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs `run` on temporary copies of assistants and instance_settings, then rolls back. `withPipeline`: assistants as
 * before 0156, with voice_pipeline.
 */
async function onTemporaryTables<T>(withPipeline: boolean, run: (tx: Tx) => Promise<T>) {
  let result: T | undefined
  const rollback = new Error('rollback')
  await db
    .transaction(async tx => {
      await tx.execute(
        sql.raw(`CREATE TEMP TABLE "assistants" (LIKE public."assistants" INCLUDING DEFAULTS) ON COMMIT DROP`),
      )
      if (withPipeline) await tx.execute(sql.raw(`ALTER TABLE pg_temp."assistants" ADD COLUMN "voice_pipeline" text`))
      await tx.execute(
        sql.raw(`CREATE TEMP TABLE "instance_settings" (LIKE public."instance_settings" INCLUDING ALL) ON COMMIT DROP`),
      )
      result = await run(tx)
      throw rollback
    })
    .catch(e => {
      if (e !== rollback) throw e
    })
  return result as T
}

const voice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }
/** Assistants as an install had them: realtime, Premium picks, Standard picks, a stray realtime pick, none. */
const cases = {
  realtime: { voice_pipeline: 'realtime', llm_model: 'gpt-4.1', voice: { ...voice, model: 'eleven_v3' } },
  premiumVoice: { voice_pipeline: null, llm_model: null, voice: { ...voice, model: 'eleven_multilingual_v2' } },
  premiumModel: { voice_pipeline: 'three_stage', llm_model: 'openai/gpt-4.1', voice },
  standard: { voice_pipeline: null, llm_model: 'gpt-4.1-mini', voice: { ...voice, model: 'eleven_flash_v2_5' } },
  strayRealtime: { voice_pipeline: 'three_stage', llm_model: null, voice, realtime_model: 'gpt-realtime-2' },
  none: { voice_pipeline: null, llm_model: null, voice },
}
type Case = (typeof cases)[keyof typeof cases] & { realtime_model?: string; call_quality?: string }

async function insertCases(tx: Tx, withPipeline: boolean, level: (id: string) => string) {
  for (const [id, values] of Object.entries(cases)) {
    const { voice_pipeline, llm_model, voice: v, realtime_model } = values as Case
    await tx.execute(sql`
      INSERT INTO "assistants" ("id", "workspace_id", "call_quality", "llm_model", "voice", "realtime_model")
      VALUES (${id}, 'ws_migration', ${level(id)}, ${llm_model}, ${JSON.stringify(v)}::jsonb,
        ${realtime_model ?? 'gpt-realtime'})`)
    if (withPipeline)
      await tx.execute(sql`UPDATE "assistants" SET "voice_pipeline" = ${voice_pipeline} WHERE "id" = ${id}`)
  }
}
const readAssistants = async (tx: Tx) =>
  (await tx.execute(sql.raw(`SELECT "id", "call_quality", "llm_model", "realtime_model", "voice" FROM "assistants"`)))
    .rows as Row[]

/** Every assistant on Standard, no model picks of its own, its voice kept. */
function expectAllStandard(rows: Row[]) {
  expect(rows).toHaveLength(Object.keys(cases).length)
  for (const row of rows) {
    expect(row).toMatchObject({ call_quality: 'standard', llm_model: null, realtime_model: null })
    expect(row.voice).toEqual(voice)
  }
}

test('0153: every assistant on Standard with the defaults, whatever its pipeline or picks', async () => {
  expect(updates0153).toHaveLength(1)
  const rows = await onTemporaryTables(true, async tx => {
    await insertCases(tx, true, () => 'standard')
    for (const statement of updates0153) await tx.execute(sql.raw(statement))
    return readAssistants(tx)
  })
  expectAllStandard(rows)
})

test("0153, the install's settings: Premium and Ultra on, new assistants on Standard whatever the old policy; a stored row stays", async () => {
  expect(settingsInsert).toHaveLength(1)
  const settingsAfter = (policy: string | null, stored?: string) =>
    onTemporaryTables(true, async tx => {
      if (policy !== null)
        await tx.execute(
          sql`INSERT INTO "instance_settings" ("key", "value") VALUES ('voice_pipeline.policy', ${policy})`,
        )
      if (stored)
        await tx.execute(sql`INSERT INTO "instance_settings" ("key", "value") VALUES ('call_quality', ${stored})`)
      await tx.execute(sql.raw(settingsInsert[0]!))
      const [row] = (await tx.execute(sql.raw(`SELECT "value" FROM "instance_settings" WHERE "key" = 'call_quality'`)))
        .rows as { value: string }[]
      return JSON.parse(row!.value)
    })
  const fresh = { premium: true, ultra: true, default: 'standard', models: { standard: {}, premium: {}, ultra: {} } }
  expect(await settingsAfter('realtime')).toEqual(fresh)
  expect(await settingsAfter('three_stage')).toEqual(fresh)
  expect(await settingsAfter('choice')).toEqual(fresh)
  expect(await settingsAfter(null)).toEqual(fresh)
  expect(await settingsAfter('realtime', '{"kept":true}')).toEqual({ kept: true })
})

test('0158: after 0153 as it first was, every assistant back on Standard with the defaults, and new ones on Standard', async () => {
  expect(migration0158.map(s => s.split(' ')[0])).toEqual(['UPDATE', 'UPDATE'])
  // As the first 0153 left them: Ultra, Premium, Standard.
  const levels: Record<string, string> = { realtime: 'ultra', premiumVoice: 'premium', premiumModel: 'premium' }
  const after = (stored: string | null) =>
    onTemporaryTables(false, async tx => {
      await insertCases(tx, false, id => levels[id] ?? 'standard')
      if (stored !== null)
        await tx.execute(sql`INSERT INTO "instance_settings" ("key", "value") VALUES ('call_quality', ${stored})`)
      for (const statement of migration0158) await tx.execute(sql.raw(statement))
      const settings = (await tx.execute(sql.raw(`SELECT "value" FROM "instance_settings"`))).rows as {
        value: string
      }[]
      return { rows: await readAssistants(tx), settings: settings.map(s => s.value) }
    })
  const ultraDefault = {
    premium: true,
    ultra: false,
    default: 'ultra',
    models: { standard: { llm: 'gpt-4.1-mini' }, premium: {}, ultra: { realtime: 'gpt-realtime' } },
  }
  const migrated = await after(JSON.stringify(ultraDefault))
  expectAllStandard(migrated.rows)
  // Only the default changes; the switches and the models stay as the server admin set them.
  expect(migrated.settings.map(v => JSON.parse(v))).toEqual([{ ...ultraDefault, default: 'standard' }])
  // No settings row, or one that is no JSON object (it reads as the install default, Standard): left as it is.
  expect((await after(null)).settings).toEqual([])
  expect((await after('not json')).settings).toEqual(['not json'])
})
