// Warns, never fails, when the German number block list in apps/api/src/de-areas.data.ts is older than 75 days: the
// weekly workflow (.github/workflows/de-areas.yml) should have opened a PR with a newer one by then, so either its
// PRs are not merged or it stopped working. Run in CI (ci.yml, job `check`); in GitHub Actions the warning is an
// annotation on the run. `node apps/api/scripts/de-areas-age.ts`
import { DE_AREAS_EDITIONS } from '../src/de-areas.data.ts'

const MAX_AGE_DAYS = 75

const asOf = DE_AREAS_EDITIONS.rufnummernbloecke
const days = Math.floor((Date.now() - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000)
if (Number.isNaN(days)) {
  console.log(`::warning title=German area data::No date for the number block list (${asOf}).`)
} else if (days > MAX_AGE_DAYS) {
  const text =
    `The German number block list in apps/api/src/de-areas.data.ts is from ${asOf}, ${days} days old ` +
    `(more than ${MAX_AGE_DAYS}). Merge the "German area data" PR or run pnpm --filter @linedesk/api de-areas:update.`
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=German area data::${text}` : `Warning: ${text}`)
} else {
  console.log(`German number block list from ${asOf} (${days} days old).`)
}
