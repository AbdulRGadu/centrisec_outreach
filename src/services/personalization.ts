import type { LeadRow } from '../types';
import { normalizeInlineText, normalizeMultilineText } from '../util/text.ts';
import {
  leadShowsWarmIntent,
  segmentLead,
  type LeadSegmentationResult,
} from './leadSegmentation.ts';

export interface NormalizedProspect {
  first_name: string;
  company_name: string;
  industry: string;
  segment: string;
  role: string;
  country: string;
  notes: string;
}

export interface DraftPersonalizationPlan {
  prospect: NormalizedProspect;
  strategy: LeadSegmentationResult;
  outreach_angle: string;
  is_warm: boolean;
}

function outreachAngle(strategy: LeadSegmentationResult): string {
  switch (strategy.buyer_persona) {
    case 'founder':
    case 'ceo':
      return 'Give leadership a practical starting point that is useful without requiring a large project.';
    case 'cto':
    case 'ciso':
    case 'it_manager':
      return 'Focus on access control, cloud or account security, and incident readiness in day-to-day operations.';
    case 'operations':
      return 'Connect secure access and staff workflows to dependable day-to-day operations.';
    case 'compliance':
      return 'Connect practical controls to accountable data handling and incident readiness.';
    case 'admin':
      return 'Focus on staff awareness, shared accounts or devices, and sensitive records.';
    default:
      return 'Offer a practical security-readiness starting point without assuming an existing problem.';
  }
}

export function buildPersonalizationPlan(lead: LeadRow): DraftPersonalizationPlan {
  const normalizedInput = {
    companyName: normalizeInlineText(lead.company, 160),
    industry: normalizeInlineText(lead.industry, 120),
    subIndustry: normalizeInlineText(lead.sub_industry, 120),
    contactRole: normalizeInlineText(lead.role, 120),
    country: normalizeInlineText(lead.country, 100),
    notes: normalizeMultilineText(lead.notes, 1600),
    source: normalizeInlineText(lead.source, 40),
    website: normalizeInlineText(lead.company_website, 240),
    domain: normalizeInlineText(lead.domain, 180),
    fitScore: lead.fit_score,
  };
  const strategy = segmentLead(normalizedInput);

  return {
    prospect: {
      first_name: normalizeInlineText(lead.first_name, 80),
      company_name: normalizedInput.companyName,
      industry: normalizedInput.industry || normalizedInput.subIndustry,
      segment: strategy.segment,
      role: normalizedInput.contactRole,
      country: normalizedInput.country,
      notes: normalizedInput.notes,
    },
    strategy,
    outreach_angle: outreachAngle(strategy),
    is_warm: leadShowsWarmIntent(normalizedInput),
  };
}
