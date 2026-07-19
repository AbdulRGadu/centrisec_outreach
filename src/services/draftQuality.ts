import type { LeadRow } from '../types';
import { wordCount } from '../util/text.ts';
import { expectedGreeting } from './emailRenderer.ts';
import { leadShowsWarmIntent, type LeadSegmentationResult } from './leadSegmentation.ts';

export interface DraftQualityResult {
  valid: boolean;
  status: 'passed' | 'needs_review';
  warnings: string[];
  word_count: number;
  question_count: number;
  checks: DraftQualityCheck[];
}

export interface DraftQualityCheck {
  id: string;
  label: string;
  passed: boolean;
}

const PRACTICAL_TERMS = /\b(?:access control|staff awareness|incident readiness|incident response|cloud security|account security|customer data|patient data|student data|client data|sensitive (?:business )?data|shared devices|security readiness)\b/i;
const OFFER_TERMS = /\b(?:checklist|posture review|readiness review|security review|walkthrough)\b/i;
const VAGUE_FILLER = /\b(?:we help (?:saas )?(?:companies|businesses|teams) (?:reduce risk|improve security|protect (?:their|your) business)|cybersecurity solutions)\b/i;

const SEGMENT_RELEVANCE: Record<LeadSegmentationResult['segment'], RegExp> = {
  fintech: /\b(?:fintech|customer data|transaction|payment|access control|incident readiness|trust)\b/i,
  healthcare: /\b(?:healthcare|patient data|staff access|service continuity|clinical)\b/i,
  education: /\b(?:school|education|student data|staff account|shared device|payment record)\b/i,
  logistics: /\b(?:logistics|shipment|customer data|staff access|uptime|operations?)\b/i,
  saas: /\b(?:saas|customer data|admin access|cloud tool|user account)\b/i,
  ecommerce: /\b(?:e-?commerce|customer data|payment workflow|admin account|third-party tool)\b/i,
  professional_services: /\b(?:professional service|client file|email access|shared document|staff device|sensitive information)\b/i,
  general_business: /\b(?:growing team|access control|staff awareness|shared tool|incident response|business data)\b/i,
};

function leadText(lead: LeadRow): string {
  return [lead.company, lead.industry, lead.sub_industry, lead.segment, lead.notes, lead.structured_notes]
    .filter(Boolean)
    .join(' ');
}

function countCtas(body: string): number {
  const questions = (body.match(/\?/g) ?? []).length;
  const nonQuestionAsks = body
    .split(/\n+/)
    .filter((line) => /\b(?:let me know|reply if|schedule a|book a|send me|can we)\b/i.test(line) && !line.includes('?'))
    .length;
  return questions + nonQuestionAsks;
}

export function validateDraftQuality(
  subject: string,
  body: string,
  lead: LeadRow,
  strategy?: LeadSegmentationResult,
  sourceBody = body
): DraftQualityResult {
  const warnings: string[] = [];
  const normalized = body.replace(/\r\n?/g, '\n').trim();
  const raw = sourceBody.replace(/\r\n?/g, '\n').trim();
  const blocks = normalized.split(/\n\s*\n/).filter(Boolean);
  const words = wordCount(normalized);
  const questions = (raw.match(/\?/g) ?? []).length;
  const allLeadText = leadText(lead);
  const companyIsCentrisec = /^centrisec(?:\s|$)/i.test(lead.company ?? '');
  const warm = leadShowsWarmIntent({ source: lead.source, notes: lead.notes });

  if (subject.trim().length < 3) warnings.push('Subject is too short.');
  if (wordCount(subject) > 8) warnings.push('Subject is longer than 8 words.');
  if (words < 80) warnings.push('Body is shorter than 80 words.');
  if (words > 140) warnings.push('Body exceeds the 140-word quality limit.');
  if (blocks.length !== 7) warnings.push('Body must contain exactly seven structured paragraphs including greeting and signoff.');
  if (blocks[0] !== expectedGreeting(lead)) warnings.push(`Greeting must be exactly "${expectedGreeting(lead)}".`);
  if (!/^I['\u2019]m reaching out from Centrisec\.$/.test(blocks[1] ?? '')) {
    warnings.push('Sender line must be one short Centrisec introduction.');
  }
  if (!PRACTICAL_TERMS.test(blocks[2] ?? '')) warnings.push('Practical help paragraph lacks a concrete security area.');
  if (strategy && !SEGMENT_RELEVANCE[strategy.segment].test(blocks[3] ?? '')) {
    warnings.push(`Sector paragraph is not specific enough for the ${strategy.segment} segment.`);
  }
  if (!OFFER_TERMS.test(blocks[4] ?? '')) warnings.push('Helpful offer is missing or unclear.');
  if (strategy && (blocks[5] ?? '').trim() !== strategy.recommended_cta) {
    warnings.push('CTA does not match the recommended low-friction next step.');
  }
  if (questions !== 1 || countCtas(raw) !== 1) warnings.push('Body must contain exactly one CTA question.');
  if (!/^Best,\nCentrisec Team$/.test(blocks[6] ?? '')) warnings.push('Signoff must appear exactly once as Best, then Centrisec Team.');

  if (/since Centrisec operates/i.test(raw) && !companyIsCentrisec) {
    warnings.push('Centrisec is incorrectly described as the prospect.');
  }
  if (/\bstartup like yours\b/i.test(raw) && !/\bstartup\b/i.test(allLeadText)) {
    warnings.push('Draft calls the prospect a startup without supporting lead data.');
  }
  if (/\bSaaS compan(?:y|ies)\b/i.test(raw) && strategy?.segment !== 'saas') {
    warnings.push('Draft calls the prospect a SaaS company without supporting lead data.');
  }
  if (/\b(?:we found|we detected|we identified|our scan|we scanned|we audited|your (?:company|team|systems?) (?:has|have|lacks?)|you have)\b.{0,55}\b(?:vulnerabilit|security gap|weak control|exposure)\b/i.test(raw)) {
    warnings.push('Draft claims an unverified vulnerability or security gap.');
  }
  if (/\bproposal\b/i.test(raw) && !warm) warnings.push('A proposal is too early for this cold lead.');
  if (/https?:\/\/\S*(?:unsubscribe|opt[-_]?out)\S*/i.test(raw)) warnings.push('An unsubscribe URL is present.');
  if (/\b(?:unsubscribe|opt out)\b/i.test(raw)) warnings.push('AI body includes footer or unsubscribe text.');
  if (/Centrisec \| Managed Cybersecurity|centrisec_fulllogo|abdul\.gadu@centrisec\.com|\+234\s*907/i.test(raw)) {
    warnings.push('AI body includes system footer content.');
  }
  if (/^\s*\u2014\s*$/m.test(raw)) warnings.push('A standalone em dash separator is present.');
  const bestSignoffs = (raw.match(/^Best,$/gim) ?? []).length;
  const teamSignoffs = (raw.match(/^Centrisec Team$/gim) ?? []).length;
  if (bestSignoffs !== 1 || teamSignoffs !== 1) warnings.push('Signoff is missing or duplicated.');
  if ((raw.match(/\bCentrisec\b/gi) ?? []).length > 2) warnings.push('Centrisec is mentioned more often than needed.');
  if (VAGUE_FILLER.test(raw)) warnings.push('Draft uses vague filler without practical detail.');
  if (/\b(?:guaranteed|limited time|act now|urgent(?:ly)?|final chance|before it['\u2019]s too late)\b/i.test(raw)) {
    warnings.push('Draft contains hype or fake urgency.');
  }

  const uniqueWarnings = [...new Set(warnings)];
  const failed = (pattern: RegExp): boolean => uniqueWarnings.some((warning) => pattern.test(warning));
  const checks: DraftQualityCheck[] = [
    { id: 'subject', label: 'Clear subject of eight words or fewer', passed: !failed(/^Subject /) },
    { id: 'length', label: 'Body is between 80 and 140 words', passed: !failed(/^Body (?:is shorter|exceeds)/) },
    { id: 'structure', label: 'Seven readable blocks with the correct greeting and sender line', passed: !failed(/seven structured|Greeting|Sender line/) },
    { id: 'practical_help', label: 'Practical cybersecurity help is concrete', passed: !failed(/Practical help|vague filler/) },
    { id: 'sector_relevance', label: 'Sector context matches supported lead data', passed: !failed(/Sector paragraph|prospect|startup|SaaS company/) },
    { id: 'offer', label: 'One useful low-friction offer', passed: !failed(/Helpful offer|proposal/) },
    { id: 'cta', label: 'One recommended soft CTA only', passed: !failed(/CTA/) },
    { id: 'signoff', label: 'Centrisec signoff appears exactly once', passed: !failed(/Signoff|mentioned more often/) },
    {
      id: 'safety',
      label: 'No invented claims, footer, hype, urgency, or unsubscribe copy',
      passed: !failed(/unverified|unsubscribe|footer|em dash|hype|urgency/),
    },
  ];
  return {
    valid: uniqueWarnings.length === 0,
    status: uniqueWarnings.length === 0 ? 'passed' : 'needs_review',
    warnings: uniqueWarnings,
    word_count: words,
    question_count: questions,
    checks,
  };
}
