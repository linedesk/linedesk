// Storage that never throws (safeStorage.ts).
import { afterEach, expect, test, vi } from 'vitest'
import { readStored, readStoredJson, storedFlag, writeStored, writeStoredJson } from './safeStorage.ts'

const memory = () => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}
afterEach(() => vi.unstubAllGlobals())

test('reads, writes and removes text and JSON; a flag per id', () => {
  vi.stubGlobal('localStorage', memory())
  vi.stubGlobal('sessionStorage', memory())
  writeStored('session', 'a', 'x')
  expect(readStored('session', 'a')).toBe('x')
  expect(readStored('local', 'a')).toBe(null)
  writeStored('session', 'a', null)
  expect(readStored('session', 'a')).toBe(null)
  writeStoredJson('local', 'j', { n: 1 })
  expect(readStoredJson('local', 'j')).toEqual({ n: 1 })
  writeStored('local', 'j', '{not json')
  expect(readStoredJson('local', 'j')).toBe(null)
  const flag = storedFlag('p.')
  flag.set('w1', true)
  expect(flag.on('w1')).toBe(true)
  expect(flag.on('w2')).toBe(false)
  flag.set('w1', false)
  expect(flag.on('w1')).toBe(false)
})

test('a blocked storage reads as nothing and never throws', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
    removeItem: () => {
      throw new Error('blocked')
    },
  }
  vi.stubGlobal('localStorage', blocked)
  expect(readStored('local', 'a')).toBe(null)
  expect(() => writeStored('local', 'a', 'x')).not.toThrow()
  expect(readStoredJson('local', 'a')).toBe(null)
})
