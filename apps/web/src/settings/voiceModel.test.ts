import { describe, expect, it } from 'vitest'
import { cloneProblem, fileToBase64, previewUrl, voiceInEffect } from './voiceModel.ts'

describe('voice picker', () => {
  it('a voice picked for another provider does not apply: the default is shown', () => {
    expect(voiceInEffect({ provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }, 'elevenlabs')).toBe(
      'cgSgspJ2msm6clMCkdW9',
    )
    expect(voiceInEffect({ provider: 'cartesia', voice_id: 'abc-123-def-456' }, 'elevenlabs')).toBe('')
    expect(voiceInEffect({ provider: 'elevenlabs', voice_id: 'x' }, null)).toBe('')
  })
  it('previews', () => {
    expect(previewUrl('cgSgspJ2msm6clMCkdW9')).toBe('/v1/voices/preview/cgSgspJ2msm6clMCkdW9')
  })
  it('cloning needs a name, a recording of a known type up to 10 MB, and consent', () => {
    const file = { size: 1_000_000, type: 'audio/mpeg' }
    expect(cloneProblem({ name: 'Mike', file, consent: true })).toBeNull()
    expect(cloneProblem({ name: ' ', file, consent: true })).toMatch(/name/)
    expect(cloneProblem({ name: 'Mike', file: null, consent: true })).toMatch(/recording/)
    expect(cloneProblem({ name: 'Mike', file: { ...file, type: 'video/mp4' }, consent: true })).toMatch(/MP3/)
    expect(cloneProblem({ name: 'Mike', file: { ...file, size: 11 * 1024 * 1024 }, consent: true })).toMatch(/11\.0 MB/)
    expect(cloneProblem({ name: 'Mike', file, consent: false })).toMatch(/agreed/)
  })
  it('reads a recording as base64', async () => {
    expect(await fileToBase64(new Blob(['RIFF']))).toBe('UklGRg==')
  })
})
