// How the proxy (docker/Caddyfile) reaches the API and the web app: by name, looked up every second, retrying only a
// request that reached no container (updates without downtime, scripts/deploy.sh). Never a passive health check:
// Caddy 2.11 counts a browser's cancelled HTTP/3 request as the container's failure, which took the only API out for
// 10 s (every page stalled up to the 30 s retry limit; staging, 2026-11-18). Never a retry of a request that reached
// a container: a cancelled one was retried for 30 s, looking the name up again with its cancelled context each time.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const root = new URL('../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const caddyfile = read('docker/Caddyfile')

/** Lines without comments, trimmed, empty ones dropped. */
const code = (text: string) =>
  text
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)

/** Every reverse_proxy block that looks its upstreams up by name (`dynamic a`), as its code lines. */
const dynamicProxies = () => {
  const lines = code(caddyfile)
  const blocks: string[][] = []
  lines.forEach((line, start) => {
    if (line !== 'reverse_proxy {') return
    let depth = 0
    for (let i = start; i < lines.length; i++) {
      if (lines[i]!.endsWith('{')) depth++
      if (lines[i] === '}') depth--
      if (depth === 0) {
        const block = lines.slice(start, i + 1)
        if (block.includes('dynamic a {')) blocks.push(block)
        return
      }
    }
    throw new Error('reverse_proxy block without an end')
  })
  return blocks
}

describe('proxy upstreams (docker/Caddyfile)', () => {
  test('the API and the web app are looked up by name every second', () => {
    const names = dynamicProxies().map(block => block.find(line => line.startsWith('name '))!)
    expect(names).toEqual(['name {$API_HOST:api}', 'name {$WEB_HOST:web}'])
    for (const block of dynamicProxies()) expect(block).toContain('refresh 1s')
  })

  test('a request that reached no container is retried for up to 30 s, nothing else is retried', () => {
    for (const block of dynamicProxies()) {
      expect(block).toContain('lb_try_duration 30s')
      expect(block).toContain('lb_try_interval 250ms')
      // Each lb_retry_match is another OR'd matcher set: a second one (e.g. `method GET`) would retry again.
      expect(block.filter(line => line.startsWith('lb_retry_match')).length).toBe(1)
      const at = block.indexOf('lb_retry_match {')
      expect(at).toBeGreaterThan(0)
      expect(block.slice(at, at + 3)).toEqual(['lb_retry_match {', 'expression false', '}'])
    }
  })

  test('no container is ever marked as down', () => {
    for (const block of dynamicProxies()) {
      const directives = block.map(line => line.split(/\s+/)[0])
      // Passive (a failed request) and active (a polled endpoint) health checks both mark a container down.
      for (const healthCheck of [
        'fail_duration',
        'max_fails',
        'unhealthy_status',
        'unhealthy_latency',
        'unhealthy_request_count',
        'health_uri',
        'health_path',
        'health_upstream',
        'health_port',
        'health_interval',
        'health_passes',
        'health_fails',
        'health_timeout',
        'health_status',
        'health_body',
        'health_method',
        'health_request_body',
        'health_headers',
        'health_follow_redirects',
      ])
        expect(directives).not.toContain(healthCheck)
    }
    expect(caddyfile).not.toMatch(/LINEDESK_PROXY_FAIL_DURATION/)
    for (const compose of ['docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.https.yml'])
      expect(read(compose)).not.toMatch(/LINEDESK_PROXY_FAIL_DURATION/)
  })
})
