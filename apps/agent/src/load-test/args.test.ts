import { describe, expect, it } from 'vitest'
import { callsArgs, defaultCallerMemory, parseLoadTestArgs } from './args.ts'
import { numberFor, parseCallsArgs, roomPrefix, startDelayMs } from './calls.ts'

describe('load test command line', () => {
  it('keeps the defaults of a run without a phone', () => {
    expect(parseLoadTestArgs([])).toMatchObject({
      levels: [1, 5, 10],
      scenario: 'callback-message',
      spread: '2',
      phone: false,
      remote: false,
      to: [],
      container: 'linedesk-agent-1',
      memory: '4g',
      callerMemory: '6g',
      abort: true,
    })
  })

  it('--remote implies --phone and needs the other install’s numbers', () => {
    const o = parseLoadTestArgs([
      '--remote',
      '--to',
      '+15035550100,+15035550101',
      '--calls',
      '20',
      '--caller-memory',
      '6g',
      '--caller-cpuset',
      '2-7',
    ])
    expect(o).toMatchObject({
      remote: true,
      phone: true,
      to: ['+15035550100', '+15035550101'],
      levels: [20],
      callerMemory: '6g',
      callerCpuset: '2-7',
    })
    expect(() => parseLoadTestArgs(['--remote'])).toThrow(/--remote needs --to/)
  })

  it('--remote refuses the flags that change the local business agent', () => {
    expect(() => parseLoadTestArgs(['--remote', '--to', '+15035550100', '--memory', '4g'])).toThrow(/drop --memory/)
    expect(() => parseLoadTestArgs(['--remote', '--to', '+15035550100', '--container', 'x', '--cpuset', '1'])).toThrow(
      /--container, --cpuset/,
    )
  })

  it('refuses --pipeline over the phone: the assistant’s own setting applies there', () => {
    expect(() => parseLoadTestArgs(['--phone', '--pipeline', 'three_stage'])).toThrow(/without a phone only/)
    expect(() => parseLoadTestArgs(['--remote', '--to', '+15035550100', '--pipeline', 'three_stage'])).toThrow(
      /without a phone only/,
    )
    expect(parseLoadTestArgs(['--pipeline', 'three_stage']).pipeline).toBe('three_stage')
  })

  it('checks numbers, levels, scenario and spread', () => {
    expect(() => parseLoadTestArgs(['--phone', '--to', '5035550100'])).toThrow(/E\.164/)
    expect(() => parseLoadTestArgs(['--calls', '1,0'])).toThrow(/--calls/)
    expect(() => parseLoadTestArgs(['--calls', 'x'])).toThrow(/--calls/)
    expect(() => parseLoadTestArgs(['--scenario', 'rob-a-bank'])).toThrow(/--scenario/)
    expect(() => parseLoadTestArgs(['--spread', '-1'])).toThrow(/--spread/)
    expect(() => parseLoadTestArgs(['--to', '--phone'])).toThrow(/--to takes a value/)
    expect(parseLoadTestArgs(['--no-abort']).abort).toBe(false)
  })

  it('passes a level to calls.ts, which reads it back', () => {
    const o = parseLoadTestArgs(['--remote', '--to', '+15035550100,+15035550101', '--spread', '3'])
    const args = callsArgs(o, 20, 'ab12cd34-1', 'linedesk-load-caller')
    expect(parseCallsArgs(args)).toEqual({
      calls: 20,
      callerAgent: 'linedesk-load-caller',
      run: 'ab12cd34-1',
      scenario: 'callback-message',
      spreadMs: 3000,
      phone: true,
      to: ['+15035550100', '+15035550101'],
    })
    expect(() => parseCallsArgs(['2', '--caller-agent', 'c'])).toThrow(/--run/)
    expect(() =>
      parseCallsArgs(['2', '--caller-agent', 'c', '--run', 'r', '--phone', '--pipeline', 'realtime']),
    ).toThrow(/without a phone only/)
  })
})

describe('load test calls', () => {
  it('starts phone calls within the spread window, calls without a phone a spread apart', () => {
    expect(Array.from({ length: 4 }, (_, i) => startDelayMs(i, 4, 2000, true))).toEqual([0, 500, 1000, 1500])
    expect(Array.from({ length: 3 }, (_, i) => startDelayMs(i, 3, 2000, false))).toEqual([0, 2000, 4000])
  })

  it('dials the numbers in turn', () => {
    const to = ['+15035550100', '+15035550101']
    expect([0, 1, 2, 3].map(i => numberFor(i, to))).toEqual([
      '+15035550100',
      '+15035550101',
      '+15035550100',
      '+15035550101',
    ])
  })

  it('names rooms so the kill switch finds every level of a run and nothing else', () => {
    const room = `${roomPrefix('ab12cd34-1')}7`
    expect(room.startsWith(roomPrefix('ab12cd34'))).toBe(true)
    expect(room.startsWith(roomPrefix('ab12cd3'))).toBe(false)
  })

  it('gives the callers memory for the biggest level when --caller-memory is not given', () => {
    expect(defaultCallerMemory(1)).toBe('3g')
    expect(defaultCallerMemory(5)).toBe('4g')
    expect(defaultCallerMemory(20)).toBe('11g')
    expect(parseLoadTestArgs(['--calls', '1,20']).callerMemory).toBe('11g')
    expect(parseLoadTestArgs(['--calls', '1,20', '--caller-memory', '8g']).callerMemory).toBe('8g')
  })
})
