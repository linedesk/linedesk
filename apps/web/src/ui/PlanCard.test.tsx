// The one plan card (PlanCard.tsx): with a trial "14 days free" leads and the price follows, else the price leads; what
// the plan includes as check rows, the conditions in one grey line, "See all details" closed, a row only where the
// install has the option.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { PlanCard } from './PlanCard.tsx'

const prices = {
  includedNumbers: 1,
  includedMinutes: 50,
  includedCalls: 5,
  standardMicrosPerMinute: 50_000,
  premiumMicrosPerMinute: 100_000,
  ultraMicrosPerMinute: 200_000,
  extraNumberCents: 300,
}
const calls = { step: 5, maxExtra: 45, extraCallCents: 100 }
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

test('a trial: "14 days free" large, then the price and its note, the included rows, the tax line, "See all details" closed', () => {
  const html = renderToStaticMarkup(
    <PlanCard trialDays={14} price="$9 a month" unit="per workspace" note="$108 billed yearly" prices={prices} />,
  )
  expect(text(html)).toMatch(
    /^14 days free Then \$9 a month per workspace \$108 billed yearly A phone number 50 call minutes each month, then 5¢ a minute 5 calls at the same time Plus tax where it applies\. See all details/,
  )
  expect(html).toContain('<span class="plan-card-price">14 days free</span>')
  expect(html).toMatch(/<details class="plan-card-all"><summary>/)
  expect(html).not.toMatch(/<details[^>]* open/)
  // One "per workspace" (in the price line), not on every row.
  expect(text(html).match(/per workspace/g)).toHaveLength(1)
})

test('no trial: the price is the headline, the same included rows', () => {
  const html = renderToStaticMarkup(<PlanCard price="$11 a month" unit="per workspace" note={null} prices={prices} />)
  expect(html).toContain('<span class="plan-card-price">$11 a month</span>')
  expect(text(html)).toMatch(/^\$11 a month per workspace A phone number 50 call minutes/)
  expect(text(html)).not.toMatch(/days free|Then \$11/)
})

test('"See all details": the install\'s other prices; the included number and calls are not repeated there', () => {
  const all = text(renderToStaticMarkup(<PlanCard price="$11 a month" note={null} prices={prices} calls={calls} />))
  const details = all.slice(all.indexOf('See all details'))
  expect(details).toContain('Premium call quality Optional, you turn it on per assistant 10¢ a minute')
  expect(details).toContain('Ultra call quality Optional, you turn it on per assistant 20¢ a minute')
  expect(details).toContain('Extra phone numbers $3 a month each')
  expect(details).toContain('5 more calls at the same time $5 a month')
  expect(details).toContain(
    'Extra minutes and numbers are paid from your balance. Auto-recharge is off until you turn it on.',
  )
  expect(details).not.toMatch(/A phone number|5 calls at the same time/)
  const fewer = text(
    renderToStaticMarkup(
      <PlanCard
        price="$11 a month"
        note={null}
        prices={{ ...prices, ultraMicrosPerMinute: null, extraNumberCents: 0 }}
        calls={{ ...calls, maxExtra: 0 }}
      />,
    ),
  )
  expect(fewer).toContain('Premium call quality')
  expect(fewer).not.toMatch(/Ultra|Extra phone numbers|more calls at the same time/)
})

test('several workspaces: one small label above the rows; no prices: no rows and no "See all details"', () => {
  const partner = text(renderToStaticMarkup(<PlanCard price="$14 a month" note={null} prices={prices} each="client" />))
  expect(partner).toContain('Each client workspace includes: A phone number 50 call minutes each month')
  const cloud = text(
    renderToStaticMarkup(<PlanCard price="$11 a month" note={null} prices={prices} each="workspace" />),
  )
  expect(cloud).toContain('Each workspace includes: A phone number')
  const two = text(
    renderToStaticMarkup(<PlanCard price="$11 a month" note={null} prices={{ ...prices, includedNumbers: 2 }} />),
  )
  expect(two).toContain('2 phone numbers')
  const none = text(renderToStaticMarkup(<PlanCard price="$14 a month" note={null} prices={null} tax={false} />))
  expect(none).toBe('$14 a month')
})
