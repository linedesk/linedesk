import { expect, test } from 'vitest'
import { addressBucket, resolveClientIp } from './client-ip.ts'

test('a direct client is its socket address, whatever it sends in X-Forwarded-For', () => {
  expect(resolveClientIp('203.0.113.5', '1.2.3.4', [])).toBe('203.0.113.5')
  expect(resolveClientIp('::ffff:203.0.113.5', '1.2.3.4', ['127.0.0.1'])).toBe('203.0.113.5')
})

test('behind a trusted proxy, the last address before our proxies counts', () => {
  expect(resolveClientIp('10.0.0.2', '1.2.3.4', ['10.0.0.2'])).toBe('1.2.3.4')
  // A client that sends its own header gets a chain; only the hop our proxy added is believed.
  expect(resolveClientIp('10.0.0.2', '6.6.6.6, 1.2.3.4', ['10.0.0.2'])).toBe('1.2.3.4')
  expect(resolveClientIp('10.0.0.2', '1.2.3.4, 10.0.0.3', ['10.0.0.2', '10.0.0.3'])).toBe('1.2.3.4')
  expect(resolveClientIp('10.0.0.2', undefined, ['10.0.0.2'])).toBe('10.0.0.2')
})

test('without a connection there is no address', () => {
  expect(resolveClientIp(undefined, '1.2.3.4', [])).toBeNull()
})

test('ranges: a proxy anywhere in the compose network is trusted, an outside client is not', () => {
  const docker = ['172.16.0.0/12', '10.0.0.0/8']
  expect(resolveClientIp('172.18.0.5', '203.0.113.9', docker)).toBe('203.0.113.9')
  expect(resolveClientIp('172.18.0.5', '203.0.113.9, 172.18.0.1', docker)).toBe('203.0.113.9')
  expect(resolveClientIp('203.0.113.9', '10.0.0.1', docker)).toBe('203.0.113.9')
  expect(resolveClientIp('172.32.0.1', '1.2.3.4', docker)).toBe('172.32.0.1')
})

test('addressBucket counts IPv4 per address and IPv6 per /64, however the address is written', () => {
  expect(addressBucket('203.0.113.7')).toBe('203.0.113.7')
  expect(addressBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
  expect(addressBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
  expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64')
  expect(addressBucket('::1')).toBe('0:0:0:0::/64')
  expect(addressBucket(null)).toBe('unknown')
})
