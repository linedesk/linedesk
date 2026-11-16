// Reading a recording for after-call transcription (LIN-328): a bucket recording is streamed to a temp file and sent
// from there, never held in the API's memory; the temp file is removed once it is sent or when reading fails.
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import type { RecordingStore } from './recording-store.ts'

// The module loads db.ts, which needs a URL; this test never queries the database (runs without `pnpm db:up` too).
process.env.DATABASE_URL ||= 'postgres://unused@localhost:1/unused'
const { readRecording } = await import('./after-call-transcript.ts')

test('a bucket recording is streamed to a temp file, not held in memory, and the file is gone once it is sent', async () => {
  const bucket = { locate: async () => ({ url: 'https://bucket.example/rec.ogg' }) } as unknown as RecordingStore
  const temps = async () => (await readdir(tmpdir())).filter(name => name.startsWith('linedesk-recording-'))
  const before = await temps()
  const send =
    (bytes: number[], length = bytes.length) =>
    async () =>
      new Response(Uint8Array.from(bytes), { headers: { 'content-length': String(length) } })

  const recording = await readRecording(bucket, 'ws/call.ogg', 10, send([1, 2, 3, 4]) as typeof fetch)
  if (!recording || recording === 'too large') throw new Error('expected a recording')
  expect([...new Uint8Array(await recording.audio.arrayBuffer())]).toEqual([1, 2, 3, 4])
  expect(recording.audio.type).toBe('audio/ogg')
  expect((await temps()).length).toBe(before.length + 1)
  await recording.release()
  expect(await temps()).toEqual(before)

  // Larger than the model takes: found from the content-length, nothing is written.
  expect(await readRecording(bucket, 'ws/call.ogg', 3, send([1, 2, 3, 4]) as typeof fetch)).toBe('too large')
  // More bytes than the content-length said: cut off, and the temp file is removed.
  await expect(readRecording(bucket, 'ws/call.ogg', 10, send([1, 2, 3, 4], 2) as typeof fetch)).rejects.toThrow()
  expect(await temps()).toEqual(before)
})
