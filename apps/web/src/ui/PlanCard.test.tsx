// The one plan card (PlanCard.tsx): value first, the conditions in one grey line, "See all prices" closed, a row only
// where the install has the option.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { PlanCard } from './PlanCard.tsx'

const prices = {
  includedMinutes: 50,
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

test('badge, the price a month with its unit and note, two value rows, the tax line, then "See all prices" closed', () => {
  const html = renderToStaticMarkup(
    <PlanCard badge="14 days free" price="$9 a month" unit="per workspace" note="$108 billed yearly" prices={prices} />,
  )
  expect(text(html)).toMatch(
    /^14 days free \$9 a month per workspace \$108 billed yearly 50 call minutes included per workspace each month Then 5¢ a minute Plus tax where it applies\. See all prices/,
  )
  expect(html).toMatch(/<details class="plan-card-all"><summary>/)
  expect(html).not.toMatch(/<details[^>]* open/)
})

test('"See all prices": the install\'s own prices; a row whose option does not exist stays away', () => {
  const all = text(renderToStaticMarkup(<PlanCard price="$11 a month" note={null} prices={prices} calls={calls} />))
  expect(all).toContain('Premium call quality Optional, you turn it on per assistant 10¢ a minute')
  expect(all).toContain('Ultra call quality Optional, you turn it on per assistant 20¢ a minute')
  expect(all).toContain('Extra phone numbers $3 a month each')
  expect(all).toContain('5 more calls at the same time $5 a month')
  expect(all).toContain('Extra minutes are paid from your balance. Auto-recharge is off until you turn it on.')
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

test('a partner plan counts minutes per client workspace; no prices: no value rows and no "See all prices"', () => {
  const partner = text(renderToStaticMarkup(<PlanCard price="$14 a month" note={null} prices={prices} perClient />))
  expect(partner).toContain('50 call minutes included per client workspace each month')
  const none = text(renderToStaticMarkup(<PlanCard price="$14 a month" note={null} prices={null} tax={false} />))
  expect(none).toBe('$14 a month')
})
