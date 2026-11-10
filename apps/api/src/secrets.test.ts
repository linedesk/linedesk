import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'

const newKey = () => randomBytes(32).toString('base64')
const before = process.env.SECRETS_KEY
beforeEach(() => {
  process.env.SECRETS_KEY = newKey()
})
afterEach(() => {
  process.env.SECRETS_KEY = before
})

test('a value survives the round trip and is not readable in its stored form', () => {
  const stored = encryptSecret('KEY-made-up-0123456789', 'telnyx.api_key')
  expect(stored).toMatch(/^v1:/)
  expect(stored).not.toContain('KEY-made-up')
  expect(Buffer.from(stored.split(':')[3]!, 'base64').toString()).not.toContain('KEY-made-up')
  expect(decryptSecret(stored, 'telnyx.api_key')).toBe('KEY-made-up-0123456789')
})

test('the same value encrypts differently each time', () => {
  expect(encryptSecret('same', 'openai.api_key')).not.toBe(encryptSecret('same', 'openai.api_key'))
})

test('another key, another slot or a changed ciphertext do not decrypt', () => {
  const stored = encryptSecret('KEY-made-up-0123456789', 'telnyx.api_key')
  expect(() => decryptSecret(stored, 'openai.api_key')).toThrow(SecretsKeyError)
  const [v, iv, tag, text] = stored.split(':')
  const flipped = Buffer.from(text!, 'base64')
  flipped[0] = flipped[0]! ^ 1
  expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), 'telnyx.api_key')).toThrow(
    SecretsKeyError,
  )
  expect(() => decryptSecret('not a stored value', 'telnyx.api_key')).toThrow(SecretsKeyError)

  process.env.SECRETS_KEY = newKey()
  expect(() => decryptSecret(stored, 'telnyx.api_key')).toThrow(/SECRETS_KEY is not the key it was saved with/)
})

test('without a usable SECRETS_KEY nothing is encrypted', () => {
  delete process.env.SECRETS_KEY
  expect(hasSecretsKey()).toBe(false)
  expect(() => encryptSecret('value', 'telnyx.api_key')).toThrow(/SECRETS_KEY is not set/)
  process.env.SECRETS_KEY = Buffer.from('too short').toString('base64')
  expect(hasSecretsKey()).toBe(false)
  expect(() => encryptSecret('value', 'telnyx.api_key')).toThrow(/must be 32 bytes/)
})
