export interface SendJob {
  type: 'send';
  messageId: string;
}

export type LeadStatus =
  | 'new'
  | 'scored'
  | 'drafted'
  | 'approved'
  | 'queued'
  | 'sent'
  | 'replied'
  | 'bounced'
  | 'unsubscribed'
  | 'disqualified';

export type MessageStatus =
  | 'draft'
  | 'approved'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'rejected'
  | 'send_unknown'
  | 'received';

export interface LeadRow {
  id: string;
  email: string;
  domain: string;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  company: string | null;
  company_website: string | null;
  industry: string | null;
  segment: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  pain_points: string | null;
  source: string;
  status: LeadStatus;
  last_reply_classification: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  lead_id: string | null;
  direction: 'outbound' | 'inbound';
  status: MessageStatus;
  subject: string | null;
  body: string | null;
  from_email: string | null;
  to_email: string | null;
  classification: string | null;
  confidence: number | null;
  summary: string | null;
  suggested_reply: string | null;
  ai_model: string | null;
  prompt_version: string | null;
  zoho_message_id: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}
