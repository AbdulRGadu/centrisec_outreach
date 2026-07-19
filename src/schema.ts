import type { Env } from './env';
import type { ProspectSegment } from './services/leadSegmentation';
import schemaConvergenceMigration from '../migrations/0007_production_schema_convergence.sql';
import { formatD1ExecScript } from './util/sql';

const MIGRATION_ID = 7;
const MIGRATION_NAME = '0007_production_schema_convergence.sql';
const REQUIRED_COLUMNS = {
  leads: {
    sub_industry: 'sub_industry TEXT',
    sales_stage: "sales_stage TEXT NOT NULL DEFAULT 'prospecting'",
    next_action: 'next_action TEXT',
    country: 'country TEXT',
    company_size: 'company_size TEXT',
    contact_profile_url: 'contact_profile_url TEXT',
    source_url: 'source_url TEXT',
    structured_notes: 'structured_notes TEXT',
    discovery_score: 'discovery_score INTEGER',
    data_confidence: 'data_confidence INTEGER',
    last_verified_at: 'last_verified_at TEXT',
  },
  messages: {
    next_action: 'next_action TEXT',
    received_at: 'received_at TEXT',
    buyer_persona: 'buyer_persona TEXT',
    security_context: 'security_context TEXT',
    recommended_offer: 'recommended_offer TEXT',
    recommended_cta: 'recommended_cta TEXT',
    draft_quality_status: "draft_quality_status TEXT CHECK (draft_quality_status IN ('passed','needs_review'))",
    validation_warnings: 'validation_warnings TEXT',
    next_step_plan: 'next_step_plan TEXT',
  },
} as const;

const REPLY_INGEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS reply_ingest_logs (
  id TEXT PRIMARY KEY,
  from_email TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  raw_payload TEXT,
  auth_status TEXT NOT NULL CHECK (auth_status IN ('authorized','unauthorized')),
  match_status TEXT CHECK (match_status IN (
    'matched_by_message_id','matched_by_in_reply_to','matched_by_sender_email',
    'matched_by_sender_domain','unmatched'
  )),
  classification_status TEXT NOT NULL DEFAULT 'pending' CHECK (classification_status IN
    ('pending','classified','failed','skipped')),
  classification TEXT,
  confidence REAL,
  lead_id TEXT,
  inbound_message_id TEXT,
  error TEXT,
  payload_received_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_created ON reply_ingest_logs(payload_received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_message ON reply_ingest_logs(message_id);
`;

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
  const replyTable = await db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'reply_ingest_logs'"
  ).first<{ present: number }>();
  const definitions = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('leads','messages')"
  ).all<{ name: string; sql: string }>();
  const sql = new Map(definitions.results.map((row) => [row.name, row.sql ?? '']));
  return Object.keys(REQUIRED_COLUMNS.leads).every((name) => leadColumns.has(name))
    && Object.keys(REQUIRED_COLUMNS.messages).every((name) => messageColumns.has(name))
    && !!replyTable
    && (sql.get('leads') ?? '').includes("'replied_positive'")
    && (sql.get('messages') ?? '').includes("'needs_review'");
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
  await env.DB.exec(formatD1ExecScript(REPLY_INGEST_SCHEMA));
  if (!(await schemaIsReady(env.DB))) {
    try {
      await env.DB.exec(formatD1ExecScript(schemaConvergenceMigration));
    } catch (error) {
      // Concurrent isolates can race while converging the same legacy schema.
      if (!(await schemaIsReady(env.DB))) throw error;
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
