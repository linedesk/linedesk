// The data move of migration 0153 (call quality, decisions.md 2026-11-17), replayed on rows of this test only: each
// assistant gets the level its calls were priced at, and keeps only the picks that belong to it.
import { readFileSync } from 'node:fs'
import { assistants } from '@linedesk/db'
import { inArray, sql } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { createWorkspace } from './helpers.ts'

const statements = readFileSync(
  new URL('../../../packages/db/migrations/0153_call_quality.sql', import.meta.url),
  'utf8',
)
  .split('--> statement-breakpoint')
  .map(s => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(s => s.startsWith('UPDATE'))

test('levels from the pipeline and the models; picks that do not belong to the level are dropped', async () => {
  const voice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }
  const cases = {
    realtime: { voice_pipeline: 'realtime' as const, llm_model: 'gpt-4.1', voice: { ...voice, model: 'eleven_v3' } },
    premiumVoice: { voice_pipeline: null, llm_model: null, voice: { ...voice, model: 'eleven_multilingual_v2' } },
    premiumModel: { voice_pipeline: 'three_stage' as const, llm_model: 'openai/gpt-4.1', voice },
    standard: { voice_pipeline: null, llm_model: 'gpt-4.1-mini', voice: { ...voice, model: 'eleven_flash_v2_5' } },
    strayRealtime: { voice_pipeline: 'three_stage' as const, llm_model: null, voice, realtime_model: 'gpt-realtime-2' },
  }
  const ids: Record<string, string> = {}
  for (const [name, values] of Object.entries(cases)) {
    const ws = await createWorkspace(`Migration ${name} Plumbing`)
    await db
      .update(assistants)
      .set({ realtime_model: 'gpt-realtime', ...values })
      .where(inArray(assistants.id, [ws.assistant.id]))
    ids[name] = ws.assistant.id
  }
  const only = `"id" IN (${Object.values(ids)
    .map(i => `'${i}'`)
    .join(', ')})`
  expect(statements).toHaveLength(3)
  for (const statement of statements)
    await db.execute(
      sql.raw(
        statement.includes(' WHERE ')
          ? statement.replace(' WHERE ', ` WHERE ${only} AND `)
          : `${statement.replace(/;$/, '')} WHERE ${only}`,
      ),
    )
  const rows = await db
    .select()
    .from(assistants)
    .where(inArray(assistants.id, Object.values(ids)))
  const of = (name: string) => rows.find(r => r.id === ids[name])!
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
})
