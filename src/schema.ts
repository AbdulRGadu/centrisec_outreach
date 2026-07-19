import type { Env } from './env';
import type { ProspectSegment } from './services/leadSegmentation';

const MIGRATION_ID = 6;
const MIGRATION_NAME = '0006_drafting_strategy.sql';
const REQUIRED_COLUMNS = {
  leads: {
    sub_industry: 'sub_industry TEXT',
  },
  messages: {
    buyer_persona: 'buyer_persona TEXT',
    security_context: 'security_context TEXT',
    recommended_offer: 'recommended_offer TEXT',
    recommended_cta: 'recommended_cta TEXT',
    draft_quality_status: "draft_quality_status TEXT CHECK (draft_quality_status IN ('passed','needs_review'))",
    validation_warnings: 'validation_warnings TEXT',
    next_step_plan: 'next_step_plan TEXT',
  },
} as const;

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
  return Object.keys(REQUIRED_COLUMNS.leads).every((name) => leadColumns.has(name))
    && Object.keys(REQUIRED_COLUMNS.messages).every((name) => messageColumns.has(name));
}

async function recordMigration(db: D1Database): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO d1_migrations (id, name) VALUES (?1, ?2)'
  ).bind(MIGRATION_ID, MIGRATION_NAME).run();
}

async function ensureColumn(db: D1Database, table: keyof typeof REQUIRED_COLUMNS, name: string, definition: string): Promise<void> {
  if ((await tableColumns(db, table)).has(name)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
  } catch (error) {
    // Concurrent isolates can race on the same additive migration.
    if (!(await tableColumns(db, table)).has(name)) throw error;
  }
}

async function applyRequiredSchema(env: Env): Promise<void> {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const [name, definition] of Object.entries(columns)) {
      await ensureColumn(env.DB, table as keyof typeof REQUIRED_COLUMNS, name, definition);
    }
  }
  if (!(await schemaIsReady(env.DB))) throw new Error('Drafting schema remains incomplete');
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

/** Store new strategy segments safely while a legacy D1 CHECK constraint exists. */
export async function compatibleLeadSegment(db: D1Database, segment: ProspectSegment): Promise<string> {
  const row = await db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'"
  ).first<{ sql: string }>();
  if (row?.sql?.includes("'general_business'")) return segment;
  if (segment === 'education') return 'school';
  if (['ecommerce', 'professional_services', 'general_business'].includes(segment)) return 'other';
  return segment;
}
