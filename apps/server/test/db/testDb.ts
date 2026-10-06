import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to use the test database helper');
}

export interface TestDatabase {
  pool: Pool;
  schema: string;
  close(): Promise<void>;
}

/** Create an isolated schema for a test file, and drop it when close is called. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `test_${randomBytes(12).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });

  return {
    pool,
    schema,
    async close() {
      await pool.end();
      let client: PoolClient | undefined;
      try {
        client = await admin.connect();
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        client?.release();
        await admin.end();
      }
    },
  };
}

/** Run one test file's work with a fresh schema and guaranteed cleanup. */
export async function withTestDatabase<T>(
  run: (database: TestDatabase) => Promise<T>,
): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.close();
  }
}
