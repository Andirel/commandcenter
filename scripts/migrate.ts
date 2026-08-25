#!/usr/bin/env tsx
/**
 * Run database migrations.
 *
 * Migrations are ordered and idempotent. Each runs inside a transaction and is
 * recorded in `schema_migrations`, so re-running is safe and a partial failure
 * does not leave the schema half-applied.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { REPO_ROOT } from '../src/config/load.js';

const MIGRATIONS_DIR = join(REPO_ROOT, 'database', 'migrations');

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set.\n' +
      'Copy .env.example to .env and set it, or export it directly.\n' +
      'See docs/implementation-plan.md §5 for the credentials each integration needs.',
    );
    return 1;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text primary key,
        applied_at  timestamptz not null default now()
      )
    `);

    const { rows } = await client.query<{ filename: string }>('select filename from schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));

    if (!pending.length) {
      console.log(`✓ schema up to date (${files.length} migrations applied)`);
      return 0;
    }

    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`  applying ${file} … `);

      // One transaction per migration: a failure rolls back cleanly rather
      // than leaving the schema in a state no migration expects.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        console.log('ok');
      } catch (err) {
        await client.query('rollback');
        console.log('FAILED');
        console.error(`\n${(err as Error).message}\n`);
        return 1;
      }
    }

    console.log(`\n✓ applied ${pending.length} migration(s)`);
    return 0;
  } finally {
    await client.end();
  }
}

process.exit(await main());
