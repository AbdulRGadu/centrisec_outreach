import { z } from 'zod';

export const SEGMENTS = [
  'fintech',
  'healthcare',
  'school',
  'logistics',
  'saas',
  'enterprise',
  'sme',
  'other',
] as const;

export const CLASSIFICATIONS = [
  'interested',
  'wants_demo',
  'more_info',
  'referral',
  'not_now',
  'not_interested',
  'remove_me',
  'out_of_office',
  'bounce',
  'unclear',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const POSITIVE_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'interested',
  'wants_demo',
  'more_info',
  'referral',
]);

// --- Scoring ---

export const scoreResult = z.object({
  segment: z.enum(SEGMENTS),
  fit_score: z.number().min(0).max(100),
  fit_reason: z.string().min(1).max(500),
  pain_points: z.array(z.string().max(200)).max(5),
});
export type ScoreResult = z.infer<typeof scoreResult>;

export const scoreJsonSchema = {
  type: 'object',
  properties: {
    segment: { type: 'string', enum: [...SEGMENTS] },
    fit_score: { type: 'integer', minimum: 0, maximum: 100 },
    fit_reason: { type: 'string' },
    pain_points: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['segment', 'fit_score', 'fit_reason', 'pain_points'],
} as const;

// --- Email drafting ---

export const draftResult = z.object({
  subject: z.string().min(4).max(120),
  body: z.string().min(80),
});
export type DraftResult = z.infer<typeof draftResult>;

export const draftJsonSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['subject', 'body'],
} as const;

// --- Reply classification ---

export const classifyResult = z.object({
  classification: z.enum(CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(500),
});
export type ClassifyResult = z.infer<typeof classifyResult>;

export const classifyJsonSchema = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: [...CLASSIFICATIONS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
  },
  required: ['classification', 'confidence', 'summary'],
} as const;

// --- Suggested reply ---

export const suggestedReplyResult = z.object({
  reply_body: z.string().min(20),
});
export type SuggestedReplyResult = z.infer<typeof suggestedReplyResult>;

export const suggestedReplyJsonSchema = {
  type: 'object',
  properties: {
    reply_body: { type: 'string' },
  },
  required: ['reply_body'],
} as const;
