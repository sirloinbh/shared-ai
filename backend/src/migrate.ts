// Creates or updates the tables before the server starts (Dockerfile CMD).
import pg from 'pg';

import { migrate } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const applied = await migrate(pool);
  console.log(`migrate: ${applied.length ? applied.join(', ') : 'up to date'}`);
} finally {
  await pool.end();
}
