import type { LeadRow } from '../types';

export type ProspectSegment =
  | 'fintech'
  | 'healthcare'
  | 'education'
  | 'logistics'
  | 'saas'
  | 'ecommerce'
  | 'professional_services'
  | 'general_business';

export type BuyerPersona =
  | 'founder'
  | 'ceo'
  | 'cto'
  | 'ciso'
  | 'it_manager'
  | 'operations'
  | 'compliance'
  | 'admin'
  | 'unknown';

export interface LeadSegmentationInput {
  companyName?: string | null;
  industry?: string | null;
  subIndustry?: string | null;
  contactRole?: string | null;
  country?: string | null;
  notes?: string | null;
  source?: string | null;
  website?: string | null;
  domain?: string | null;
  fitScore?: number | null;
}

export interface LeadSegmentationResult {
  segment: ProspectSegment;
  buyer_persona: BuyerPersona;
  likely_security_context: string;
  recommended_offer: string;
  recommended_cta: string;
  do_not_say: string[];
}

const SECURITY_CONTEXT: Record<ProspectSegment, string> = {
  fintech:
    'For fintech teams, these checks are useful because customer data, transaction workflows, access control, and incident readiness all affect trust.',
  healthcare:
    'For healthcare teams, these checks are useful because patient data, staff access, and service continuity all need practical security controls.',
  education:
    'For schools and education teams, these checks are useful because staff accounts, student data, payment records, and shared devices can create everyday security exposure.',
  logistics:
    'For logistics teams, these checks are useful because shipment systems, customer data, staff access, and operational uptime all depend on secure workflows.',
  saas:
    'For SaaS teams, these checks are useful because customer data, admin access, cloud tools, and user accounts often sit across multiple systems.',
  ecommerce:
    'For ecommerce teams, these checks are useful because customer data, payment workflows, admin accounts, and third-party tools all depend on secure access.',
  professional_services:
    'For professional service firms, these checks are useful because client files, email access, shared documents, and staff devices often carry sensitive information.',
  general_business:
    'For growing teams, these checks are useful because access control, staff awareness, shared tools, and incident response are often easier to improve early than after a security issue.',
};

const SEGMENT_PATTERNS: Array<[ProspectSegment, RegExp]> = [
  ['fintech', /\b(?:fintech|bank(?:ing)?|payments?|lending|credit|insurtech|mobile money|digital wallet|financial technology|transaction platform)\b/i],
  ['healthcare', /\b(?:healthcare|health care|hospital|clinic|medical|patient|pharmacy|pharmaceutical|dental|healthtech)\b/i],
  ['education', /\b(?:school|education|university|college|academy|student|edtech|training institute)\b/i],
  ['logistics', /\b(?:logistics|delivery|shipment|freight|transport(?:ation)?|warehouse|warehousing|courier|supply chain|fleet)\b/i],
  ['saas', /\b(?:saas|software as a service|cloud software|subscription software|software platform)\b/i],
  ['ecommerce', /\b(?:e-?commerce|online retail|online store|digital marketplace|retail marketplace)\b/i],
  ['professional_services', /\b(?:professional services?|consult(?:ing|ancy)|law firm|legal services?|accounting|accountancy|audit firm|creative agency|marketing agency|architecture firm)\b/i],
];

function sourceText(input: LeadSegmentationInput): string {
  return [
    input.industry,
    input.subIndustry,
    input.companyName,
    input.website,
    input.domain,
    input.notes,
  ].filter(Boolean).join(' ');
}

function detectSegment(input: LeadSegmentationInput): ProspectSegment {
  const text = sourceText(input);
  for (const [segment, pattern] of SEGMENT_PATTERNS) {
    if (pattern.test(text)) return segment;
  }
  return 'general_business';
}

function detectBuyerPersona(role: string | null | undefined): BuyerPersona {
  const value = (role ?? '').trim().toLowerCase();
  if (/\b(?:co-?founder|founder|business owner|owner)\b/.test(value)) return 'founder';
  if (/\b(?:chief executive officer|ceo|managing director)\b/.test(value)) return 'ceo';
  if (/\b(?:chief information security officer|ciso|head of security|security director)\b/.test(value)) return 'ciso';
  if (/\b(?:chief technology officer|cto|vp of engineering|head of engineering|technical director)\b/.test(value)) return 'cto';
  if (/\b(?:it manager|head of it|information technology manager|systems? administrator|network administrator|technology manager|security manager)\b/.test(value)) return 'it_manager';
  if (/\b(?:chief operating officer|coo|operations?|supply chain|service delivery)\b/.test(value)) return 'operations';
  if (/\b(?:compliance|risk manager|data protection officer|dpo|governance|internal audit)\b/.test(value)) return 'compliance';
  if (/\b(?:administrator|admin|office manager|school manager)\b/.test(value)) return 'admin';
  return 'unknown';
}

export function leadShowsWarmIntent(input: LeadSegmentationInput): boolean {
  const source = (input.source ?? '').toLowerCase();
  const notes = input.notes ?? '';
  if (/\b(?:referral|inbound|existing customer|partner referral)\b/.test(source)) return true;
  return /\b(?:warm lead|requested|asked for|interested in|book(?:ing)?|demo|meeting|walkthrough|proposal)\b/i.test(notes);
}

function recommendedOffer(segment: ProspectSegment, persona: BuyerPersona, warm: boolean): string {
  if (warm) return '15-minute security readiness walkthrough';
  const technical = ['cto', 'ciso', 'it_manager', 'compliance'].includes(persona);
  const leadership = persona === 'founder' || persona === 'ceo';
  switch (segment) {
    case 'fintech': return technical ? 'access control and incident readiness checklist' : 'security readiness checklist';
    case 'saas': return technical ? 'cloud and account security checklist' : 'security readiness checklist';
    case 'healthcare': return technical || leadership ? 'patient data and staff access checklist' : 'practical security readiness review';
    case 'education': return persona === 'admin' ? 'staff awareness and student data checklist' : 'school security readiness checklist';
    case 'logistics': return technical || leadership || persona === 'operations' ? 'operations security readiness checklist' : 'access and uptime review';
    case 'professional_services': return technical ? 'email and account security readiness checklist' : 'client data protection checklist';
    case 'ecommerce': return technical ? 'customer data and account security checklist' : 'ecommerce security readiness checklist';
    default: return 'general security readiness checklist';
  }
}

function recommendedCta(persona: BuyerPersona, warm: boolean): string {
  if (warm) return 'Would a quick 15-minute walkthrough be useful?';
  if (persona === 'founder' || persona === 'ceo') {
    return 'Would a short checklist like that be useful for your team?';
  }
  if (['cto', 'ciso', 'it_manager', 'compliance'].includes(persona)) {
    return 'Would it be useful if I sent over the checklist for your team to review?';
  }
  return 'Would it be useful if I sent it over?';
}

export function segmentLead(input: LeadSegmentationInput): LeadSegmentationResult {
  const segment = detectSegment(input);
  const buyerPersona = detectBuyerPersona(input.contactRole);
  const warm = leadShowsWarmIntent(input);
  const doNotSay = [
    'Since Centrisec operates',
    'we found vulnerabilities or security gaps',
    'we scanned or audited your company',
  ];
  if (!/\bstartup\b/i.test(sourceText(input))) doNotSay.push('startup like yours');
  if (segment !== 'saas') doNotSay.push('SaaS company');
  if (!warm) doNotSay.push('proposal', 'book a demo');

  return {
    segment,
    buyer_persona: buyerPersona,
    likely_security_context: SECURITY_CONTEXT[segment],
    recommended_offer: recommendedOffer(segment, buyerPersona, warm),
    recommended_cta: recommendedCta(buyerPersona, warm),
    do_not_say: doNotSay,
  };
}

export function segmentLeadRow(lead: LeadRow): LeadSegmentationResult {
  return segmentLead({
    companyName: lead.company,
    industry: lead.industry,
    subIndustry: lead.sub_industry,
    contactRole: lead.role,
    country: lead.country,
    notes: lead.notes,
    source: lead.source,
    website: lead.company_website,
    domain: lead.domain,
    fitScore: lead.fit_score,
  });
}
