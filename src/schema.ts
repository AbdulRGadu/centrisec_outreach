import draftingStrategyMigration from '../migrations/0006_drafting_strategy.sql';
import type { Env } from './env';

const MIGRATION_ID = 6;
const MIGRATION_NAME = '0006_drafting_strategy.sql';
const REQUIRED_LEAD_COLUMNS = ['sub_industry'];
const REQUIRED_MESSAGE_COLUMNS = [
  'buyer_persona',
  'security_context',
  'recommended_offer',
  'recommended_cta',
  'draft_quality_status',
  'validation_warnings',
  'next_step_plan',
];

let readiness: Promise<void> | null = null;

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(rows.results.map((row) => row.name));
}

async function schemaIsReady(db: D1Database): Promise<boolean> {
  const [leadColumns, messageColumns] = await Promise.all([
    tableColumns(db, 'leads'),
    tableColumns(db, 'messages'),
  ]);
  return REQUIRED_LEAD_COLUMNS.every((name) => leadColumns.has(name))
    && REQUIRED_MESSAGE_COLUMNS.every((name) => messageColumns.has(name));
}

async function recordMigration(db: D1Database): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO d1_migrations (id, name) VALUES (?1, ?2)'
  ).bind(MIGRATION_ID, MIGRATION_NAME).run();
}

async function applyRequiredSchema(env: Env): Promise<void> {
  if (await schemaIsReady(env.DB)) {
    await recordMigration(env.DB);
    return;
  }

  try {
    await env.DB.exec(draftingStrategyMigration);
  } catch (error) {
    // Another Worker isolate may have completed the migration after our check.
    if (!(await schemaIsReady(env.DB))) throw error;
  }
  await recordMigration(env.DB);
}

/**
 * Git-based Worker deploys do not run D1 migrations. Ensure the schema required
 * by the deployed code exists before serving API, queue, or scheduled work.
 */
export async function ensureDraftingSchema(env: Env): Promise<void> {
  readiness ??= applyRequiredSchema(env).catch((error) => {
    readiness = null;
    throw error;
  });
  return readiness;
}
