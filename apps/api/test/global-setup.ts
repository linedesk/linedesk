import type { TestProject } from 'vitest/node'
import { createDb } from '@callfront/db'
import { createTestDatabase, dropTestDatabase } from './test-database.ts'

/** The first user of an install becomes instance admin. This one takes that place, so no test user does by accident. */
async function insertFirstUser(url: string) {
  const { pool } = createDb(url)
  try {
    await pool.query(`insert into "user" (id, name, email) values ('user_first', 'First User', 'first@callfront.test')`)
  } finally {
    await pool.end()
  }
}

/** Creates the run's database before the first test and drops it after the last. */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL
  if (!url) return // no Postgres: vitest.config.ts has excluded the tests that need it
  await createTestDatabase(url)
  await insertFirstUser(url)
  return () => dropTestDatabase(url)
}
