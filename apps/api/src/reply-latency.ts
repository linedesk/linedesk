// Reply delay for the admin overview: how long the assistant's replies take, from the caller's last word to the reply's
// first audio, split by where the time goes, per pipeline (three stages or realtime), as p50 and p90 over the last days.
// The agent stores each reply's parts at hang-up (call.recordTimings, reply_timings); the phone network's share comes
// from call tests, which hear the replies over the phone: per call, what was heard minus the agent's own total.
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'

export type Percentiles = { p50: number | null; p90: number | null }
export type PipelineLatency = {
  pipeline: 'cascaded' | 'realtime'
  replies: number
  /** Who did each part in the newest reply: turn, model, voice → provider id. */
  providers: Record<string, string>
  turn: Percentiles
  model: Percentiles
  voice: Percentiles
  server: Percentiles
  total: Percentiles
  /** The phone network (call tests over the phone): what the caller heard minus the agent's total; `calls` measured. */
  phone: Percentiles & { calls: number }
}
export type ReplyLatency = { days: number; pipelines: PipelineLatency[] }

export const LATENCY_DAYS_DEFAULT = 7
export const LATENCY_DAYS_MAX = 90

const round = (value: unknown) => (value === null || value === undefined ? null : Math.round(Number(value)))
const pct = (column: string) =>
  sql.raw(
    `percentile_cont(0.5) within group (order by ${column}) as ${column}_p50, percentile_cont(0.9) within group (order by ${column}) as ${column}_p90`,
  )
const STAGES = ['turn', 'model', 'voice', 'server', 'total'] as const

// biome-ignore lint/suspicious/noExplicitAny: rows of hand-written aggregate queries
type Row = Record<string, any>

export async function replyLatency(tx: Tx, days = LATENCY_DAYS_DEFAULT): Promise<ReplyLatency> {
  const since = sql`now() - make_interval(days => ${days})`
  const stages = (
    await tx.execute(sql`
      select pipeline, count(*)::int as replies, ${pct('turn_ms')}, ${pct('model_ms')}, ${pct('voice_ms')}, ${pct('server_ms')}, ${pct('total_ms')}
      from reply_timings where at > ${since} and pipeline in ('cascaded', 'realtime') group by pipeline`)
  ).rows as Row[]
  const providers = (
    await tx.execute(sql`
      select distinct on (pipeline) pipeline, providers from reply_timings
      where at > ${since} and pipeline in ('cascaded', 'realtime') order by pipeline, at desc`)
  ).rows as Row[]
  // Per call that a call test heard over the phone: what was heard minus what the agent measured itself.
  const phone = (
    await tx.execute(sql`
      with agent as (
        select call_id, pipeline, avg(total_ms) as total from reply_timings
        where at > ${since} and pipeline in ('cascaded', 'realtime') group by call_id, pipeline
      ), heard as (
        select call_id, avg(heard_ms) as heard from reply_timings where at > ${since} and pipeline = 'phone' group by call_id
      )
      select agent.pipeline, count(*)::int as calls,
        percentile_cont(0.5) within group (order by heard.heard - agent.total) as p50,
        percentile_cont(0.9) within group (order by heard.heard - agent.total) as p90
      from agent join heard using (call_id) group by agent.pipeline`)
  ).rows as Row[]
  return {
    days,
    pipelines: stages.map(row => {
      const network = phone.find(p => p.pipeline === row.pipeline)
      const parts = Object.fromEntries(
        STAGES.map(stage => [stage, { p50: round(row[`${stage}_ms_p50`]), p90: round(row[`${stage}_ms_p90`]) }]),
      ) as Record<(typeof STAGES)[number], Percentiles>
      return {
        pipeline: row.pipeline,
        replies: row.replies,
        providers: providers.find(p => p.pipeline === row.pipeline)?.providers ?? {},
        ...parts,
        phone: { calls: network?.calls ?? 0, p50: round(network?.p50), p90: round(network?.p90) },
      }
    }),
  }
}
