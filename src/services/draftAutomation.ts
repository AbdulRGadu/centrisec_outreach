import type { DraftPersonalizationPlan } from './personalization.ts';
import type { LeadRow } from '../types';
import { validateDraftQuality, type DraftQualityResult } from './draftQuality.ts';
import { expectedGreeting, normalizeDraftSubject, renderDraftEmail } from './emailRenderer.ts';

export interface DraftCandidate {
  subject: string;
  body: string;
}

export interface DraftRepairRequest {
  failedDraft: DraftCandidate;
  warnings: string[];
  attempt: number;
}

export type DraftRepair = (request: DraftRepairRequest) => Promise<DraftCandidate>;

export interface DraftAutomationResult extends DraftCandidate {
  quality: DraftQualityResult;
  initial_warnings: string[];
  repair_attempts: number;
  repair_failures: number;
  auto_repaired: boolean;
  used_fallback: boolean;
}

const SUBJECTS: Record<DraftPersonalizationPlan['strategy']['segment'], string> = {
  fintech: 'Practical fintech security checklist',
  healthcare: 'Practical healthcare security checklist',
  education: 'Practical school security checklist',
  logistics: 'Practical logistics security checklist',
  saas: 'Practical SaaS security checklist',
  ecommerce: 'Practical ecommerce security checklist',
  professional_services: 'Practical client data security checklist',
  general_business: 'Practical security readiness checklist',
};

function practicalHelp(plan: DraftPersonalizationPlan): string {
  switch (plan.strategy.buyer_persona) {
    case 'founder':
    case 'ceo':
      return 'We help leadership teams review access control and staff awareness through clear checks that show ownership, priorities, and sensible next actions without starting a large security project.';
    case 'cto':
    case 'ciso':
    case 'it_manager':
      return 'We help technical teams turn access control and incident readiness into clear checks for account ownership, permissions, response responsibilities, and practical follow-up actions.';
    case 'operations':
      return 'We help operations teams review staff access and incident readiness through practical checks that clarify account ownership, day-to-day responsibilities, and response steps.';
    case 'compliance':
      return 'We help compliance teams review access control and sensitive business data handling through practical checks that clarify ownership, evidence, and incident response responsibilities.';
    case 'admin':
      return 'We help administrative teams review staff awareness and account security through practical checks for shared access, sensitive records, everyday responsibilities, and response steps.';
    default:
      return 'We help growing teams review access control and incident readiness through practical checks that clarify account ownership, staff responsibilities, and useful next steps.';
  }
}

function offerSentence(plan: DraftPersonalizationPlan): string {
  const offer = plan.strategy.recommended_offer;
  if (/walkthrough/i.test(offer)) {
    return `I can offer a short ${offer} focused on the areas most relevant to your team, without turning it into a lengthy assessment.`;
  }
  return `I can send a concise ${offer} your team can use to compare current practices and decide which next steps deserve attention.`;
}

export function buildSafeFallbackDraft(lead: LeadRow, plan: DraftPersonalizationPlan): DraftCandidate {
  const body = [
    expectedGreeting(lead),
    'I’m reaching out from Centrisec.',
    practicalHelp(plan),
    plan.strategy.likely_security_context,
    offerSentence(plan),
    plan.strategy.recommended_cta,
    'Best,\nCentrisec Team',
  ].join('\n\n');
  return {
    subject: /walkthrough/i.test(plan.strategy.recommended_offer)
      ? 'Practical security readiness walkthrough'
      : SUBJECTS[plan.strategy.segment],
    body,
  };
}

function assess(candidate: DraftCandidate, lead: LeadRow, plan: DraftPersonalizationPlan): DraftCandidate & { quality: DraftQualityResult } {
  const subject = normalizeDraftSubject(candidate.subject ?? '');
  const body = renderDraftEmail(candidate.body ?? '', lead);
  return {
    subject,
    body,
    quality: validateDraftQuality(subject, body, lead, plan.strategy, candidate.body ?? ''),
  };
}

export async function improveDraftUntilSendable(args: {
  lead: LeadRow;
  plan: DraftPersonalizationPlan;
  initialDraft: DraftCandidate;
  repair: DraftRepair;
  maxRepairAttempts?: number;
}): Promise<DraftAutomationResult> {
  let current = assess(args.initialDraft, args.lead, args.plan);
  const initialWarnings = [...current.quality.warnings];
  const maxAttempts = Math.min(Math.max(args.maxRepairAttempts ?? 2, 0), 2);
  let attempts = 0;
  let failures = 0;

  while (!current.quality.valid && attempts < maxAttempts) {
    attempts++;
    try {
      const repaired = await args.repair({
        failedDraft: { subject: current.subject, body: current.body },
        warnings: current.quality.warnings,
        attempt: attempts,
      });
      current = assess(repaired, args.lead, args.plan);
    } catch {
      failures++;
    }
  }

  if (!current.quality.valid) {
    current = assess(buildSafeFallbackDraft(args.lead, args.plan), args.lead, args.plan);
    return {
      ...current,
      initial_warnings: initialWarnings,
      repair_attempts: attempts,
      repair_failures: failures,
      auto_repaired: true,
      used_fallback: true,
    };
  }

  return {
    ...current,
    initial_warnings: initialWarnings,
    repair_attempts: attempts,
    repair_failures: failures,
    auto_repaired: initialWarnings.length > 0,
    used_fallback: false,
  };
}
