// The data move of migration 0153 (call quality, decisions.md 2026-11-17), replayed as the file stands: each assistant
// gets the level its calls were priced at and keeps only the picks that belong to it, and new assistants start on the
// install's old pipeline policy. `assistants.voice_pipeline` is gone since 0156, so the replay runs on temporary tables
// shaped as before 0156 (they come first in the search path), in a transaction that is rolled back: nothing else sees them.
import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'

const migration = readFileSync(
  new URL('../../../packages/db/migrations/0153_call_quality.sql', import.meta.url),
  'utf8',
)
  .split('--> statement-breakpoint')
  .map(s => s.replace(/^\s*--.*$/gm, '').trim())
const updates = migration.filter(s => s.startsWith('UPDATE'))
const settingsInsert = migration.filter(s => s.startsWith('INSERT INTO "instance_settings"'))

type Row = {
  id: string
  call_quality: string
  llm_model: string | null
  realtime_model: string | null
  voice: Record<string, string>
}

/** Runs `run` on temporary copies of assistants (with voice_pipeline) and instance_settings, then rolls back. */
async function onTablesBefore0156<T>(run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  let result: T | undefined
  const rollback = new Error('rollback')
  await db
    .transaction(async tx => {
      await tx.execute(
        sql.raw(`CREATE TEMP TABLE "assistants" (LIKE public."assistants" INCLUDING DEFAULTS) ON COMMIT DROP`),
      )
      await tx.execute(sql.raw(`ALTER TABLE pg_temp."assistants" ADD COLUMN "voice_pipeline" text`))
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

test('levels from the pipeline and the models; picks that do not belong to the level are dropped', async () => {
  const voice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }
  const cases = {
    realtime: { voice_pipeline: 'realtime', llm_model: 'gpt-4.1', voice: { ...voice, model: 'eleven_v3' } },
    premiumVoice: { voice_pipeline: null, llm_model: null, voice: { ...voice, model: 'eleven_multilingual_v2' } },
    premiumModel: { voice_pipeline: 'three_stage', llm_model: 'openai/gpt-4.1', voice },
    standard: { voice_pipeline: null, llm_model: 'gpt-4.1-mini', voice: { ...voice, model: 'eleven_flash_v2_5' } },
    strayRealtime: { voice_pipeline: 'three_stage', llm_model: null, voice, realtime_model: 'gpt-realtime-2' },
    // A Premium model name of another voice provider is no Premium voice.
    otherProvider: {
      voice_pipeline: null,
      llm_model: null,
      voice: { provider: 'cartesia', voice_id: 'x', model: 'eleven_v3' },
    },
  }
  expect(updates).toHaveLength(3)
  const rows = await onTablesBefore0156(async tx => {
    for (const [id, values] of Object.entries(cases)) {
      const { voice_pipeline, llm_model, voice: v, ...rest } = values as typeof values & { realtime_model?: string }
      await tx.execute(sql`
        INSERT INTO "assistants" ("id", "workspace_id", "voice_pipeline", "llm_model", "voice", "realtime_model")
        VALUES (${id}, 'ws_migration', ${voice_pipeline}, ${llm_model}, ${JSON.stringify(v)}::jsonb,
          ${rest.realtime_model ?? 'gpt-realtime'})`)
    }
    for (const statement of updates) await tx.execute(sql.raw(statement))
    return (
      await tx.execute(sql.raw(`SELECT "id", "call_quality", "llm_model", "realtime_model", "voice" FROM "assistants"`))
    ).rows as Row[]
  })
  const of = (id: string) => rows.find(r => r.id === id)!
  expect(rows).toHaveLength(Object.keys(cases).length)
  expect(of('realtime')).toMatchObject({ call_quality: 'ultra', llm_model: null, realtime_model: 'gpt-realtime' })
  expect(of('realtime').voice.model).toBeUndefined()
  expect(of('premiumVoice')).toMatchObject({
    call_quality: 'premium',
    voice: { model: 'eleven_multilingual_v2' },
    realtime_model: null,
  })
  expect(of('premiumModel')).toMatchObject({ call_quality: 'premium', llm_model: 'openai/gpt-4.1' })
  expect(of('standard')).toMatchObject({
    call_quality: 'standard',
    llm_model: 'gpt-4.1-mini',
    voice: { model: 'eleven_flash_v2_5' },
    realtime_model: null,
  })
  expect(of('strayRealtime')).toMatchObject({ call_quality: 'standard', realtime_model: null })
  expect(of('otherProvider')).toMatchObject({ call_quality: 'standard', voice: { model: 'eleven_v3' } })
})

test("the install's settings: Premium and Ultra on, new assistants on Ultra only where every call was realtime; a stored row stays", async () => {
  expect(settingsInsert).toHaveLength(1)
  const settingsAfter = (policy: string | null, stored?: string) =>
    onTablesBefore0156(async tx => {
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
  const fresh = { premium: true, ultra: true, models: { standard: {}, premium: {}, ultra: {} } }
  expect(await settingsAfter('realtime')).toEqual({ ...fresh, default: 'ultra' })
  expect(await settingsAfter('three_stage')).toEqual({ ...fresh, default: 'standard' })
  expect(await settingsAfter('choice')).toEqual({ ...fresh, default: 'standard' })
  expect(await settingsAfter(null)).toEqual({ ...fresh, default: 'standard' })
  expect(await settingsAfter('realtime', '{"kept":true}')).toEqual({ kept: true })
})
