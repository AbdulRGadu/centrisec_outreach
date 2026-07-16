// The context/*.md files are bundled into the Worker as text modules
// (see "rules" in wrangler.jsonc). Editing those files + redeploy changes
// what the AI knows — no code changes needed. Because they ship inside the
// bundle, the project stays self-contained wherever the folder is copied.
import companyMd from '../../context/company.md';
import servicesMd from '../../context/services.md';
import segmentsMd from '../../context/segments.md';
import emailGuideMd from '../../context/email-guide.md';

export const knowledge = {
  company: companyMd,
  services: servicesMd,
  segments: segmentsMd,
  emailGuide: emailGuideMd,
};

function join(...sections: string[]): string {
  return sections.map((s) => s.trim()).join('\n\n---\n\n');
}

/** Company + services + segment playbook — for lead scoring. */
export function scoringContext(): string {
  return join(knowledge.company, knowledge.services, knowledge.segments);
}

/** Everything including the email guide — for drafting cold emails. */
export function draftingContext(): string {
  return join(knowledge.company, knowledge.services, knowledge.segments, knowledge.emailGuide);
}

/** Company + services — for reply handling and suggested replies. */
export function replyContext(): string {
  return join(knowledge.company, knowledge.services);
}
