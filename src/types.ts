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
  | 'replied_positive'
  | 'meeting_requested'
  | 'asked_for_more_info'
  | 'referred'
  | 'not_now'
  | 'not_interested'
  | 'suppressed'
  | 'unmatched_reply'
  | 'manual_review'
  | 'failed';

export type MessageStatus =
  | 'draft'
  | 'needs_review'
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
  sub_industry: string | null;
  segment: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  pain_points: string | null;
  source: string;
  status: LeadStatus;
  last_reply_classification: string | null;
  notes: string | null;
  country: string | null;
  company_size: string | null;
  contact_profile_url: string | null;
  source_url: string | null;
  structured_notes: string | null;
  discovery_score: number | null;
  data_confidence: number | null;
  last_verified_at: string | null;
  sales_stage: string;
  next_action: string | null;
  created_at: string;
  updated_at: string;
}

export type DiscoverySourceType =
  | 'company_website'
  | 'public_business_directory'
  | 'business_registry'
  | 'event_or_membership_list'
  | 'public_news'
  | 'professional_profile'
  | 'partner_referral'
  | 'customer_referral'
  | 'inbound_request'
  | 'manual_research'
  | 'csv_import'
  | 'official_api';

export type DiscoveryStatus = 'new' | 'enriched' | 'needs_research' | 'accepted' | 'rejected' | 'failed';

export interface StructuredDiscoveryNotes {
  company_summary: string;
  why_relevant: string;
  verified_facts: string[];
  security_relevance: string[];
  contact_relevance: string[];
  personalization_hooks: string[];
  do_not_claim: string[];
  research_gaps: string[];
}

export interface DiscoveryCandidateRow {
  id: string;
  company: string | null;
  company_domain: string | null;
  company_website: string | null;
  industry: string | null;
  country: string | null;
  company_size: string | null;
  contact_email: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_role: string | null;
  contact_profile_url: string | null;
  source_type: DiscoverySourceType;
  raw_notes: string | null;
  structured_notes: string | null;
  company_fit_score: number | null;
  role_relevance_score: number | null;
  timing_signal_score: number | null;
  discovery_score: number | null;
  data_confidence: number | null;
  score_reason: string | null;
  status: DiscoveryStatus;
  lead_id: string | null;
  last_error: string | null;
  discovered_at: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscoverySourceRow {
  id: string;
  candidate_id: string;
  lead_id: string | null;
  source_type: DiscoverySourceType;
  source_url: string | null;
  source_title: string | null;
  evidence: string | null;
  observed_at: string | null;
  created_at: string;
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
  next_action: string | null;
  received_at: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  buyer_persona: string | null;
  security_context: string | null;
  recommended_offer: string | null;
  recommended_cta: string | null;
  draft_quality_status: string | null;
  validation_warnings: string | null;
  next_step_plan: string | null;
}

export type ReplyMatchStatus =
  | 'matched_by_message_id'
  | 'matched_by_in_reply_to'
  | 'matched_by_sender_email'
  | 'matched_by_sender_domain'
  | 'unmatched';

export interface ReplyIngestLogRow {
  id: string;
  from_email: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  raw_payload: string | null;
  auth_status: 'authorized' | 'unauthorized';
  match_status: ReplyMatchStatus | null;
  classification_status: 'pending' | 'classified' | 'failed' | 'skipped';
  classification: string | null;
  confidence: number | null;
  lead_id: string | null;
  inbound_message_id: string | null;
  error: string | null;
  payload_received_at: string;
  updated_at: string;
}
