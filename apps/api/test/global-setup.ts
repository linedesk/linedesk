import type { TestProject } from 'vitest/node'
import { createTestDatabase, dropTestDatabase } from './test-database.ts'

/** Creates the run's database before the first test and drops it after the last. */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL
  if (!url) return // no Postgres: vitest.config.ts has excluded the tests that need it
  await createTestDatabase(url)
  return () => dropTestDatabase(url)
}
