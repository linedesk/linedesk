// Encryption at rest for provider keys: AES-256-GCM with the key in SECRETS_KEY (32 bytes, base64).
// Stored form: `v1:<iv>:<auth tag>:<ciphertext>`, each part base64. The slot ("telnyx.api_key") is
// authenticated with the value, so a ciphertext moved to another row does not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const HOW_TO = 'Generate one with `openssl rand -base64 32`, set it in the environment of the API and restart.'

/** SECRETS_KEY is missing, malformed, or not the key a value was stored with. The message is safe to show. */
export class SecretsKeyError extends Error {}

function secretsKey(): Buffer {
  const raw = process.env.SECRETS_KEY
  if (!raw) throw new SecretsKeyError(`SECRETS_KEY is not set, so keys cannot be stored. ${HOW_TO}`)
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new SecretsKeyError(`SECRETS_KEY must be 32 bytes, base64 encoded. ${HOW_TO}`)
  return key
}

export function hasSecretsKey(): boolean {
  try {
    secretsKey()
    return true
  } catch {
    return false
  }
}

export function encryptSecret(plain: string, slot: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretsKey(), iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(slot))
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), ciphertext]
    .map(part => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':')
}

export function decryptSecret(stored: string, slot: string): string {
  const key = secretsKey()
  const [version, iv, tag, ciphertext] = stored.split(':')
  try {
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw new Error('unknown format')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 })
    decipher.setAAD(Buffer.from(slot))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretsKeyError(
      `The stored value of ${slot} cannot be decrypted: SECRETS_KEY is not the key it was saved with. Restore that key, or set the provider's keys again.`,
    )
  }
}
