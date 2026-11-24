import type { TestProject } from 'vitest/node'
import { createDb } from '@linedesk/db'
import { createTestDatabase, dropTestDatabase } from './test-database.ts'

/** The first user of an install becomes instance admin. This one takes that place, so no test user does by accident. */
async function insertFirstUser(url: string) {
  const { pool } = createDb(url)
  try {
    await pool.query(`insert into "user" (id, name, email) values ('user_first', 'First User', 'first@linedesk.test')`)
  } finally {
    await pool.end()
  }
}

/**
 * Creates the run's databases before the first test and drops them after the last: one per project in
 * vitest.config.ts (the instance-wide files have their own), each named by its project's DATABASE_URL.
 */
export default async function setup(project: TestProject) {
  const urls = [
    ...new Set(
      [project, ...project.vitest.projects].map(p => p.config.env?.DATABASE_URL).filter((u): u is string => !!u),
    ),
  ]
  if (!urls.length) return // no Postgres: vitest.config.ts has excluded the tests that need it
  await Promise.all(
    urls.map(async url => {
      await createTestDatabase(url)
      await insertFirstUser(url)
    }),
  )
  return () => Promise.all(urls.map(dropTestDatabase))
}
