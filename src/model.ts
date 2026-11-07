import { z } from 'zod';
import type { CompanyResearch } from './company.ts';
import { priorityCountries, callHeavyIndustries } from './fit.ts';
import { weightsSchema } from './scoring.ts';

export const columns = ['lead_id','first_name','last_name','title','company','industry','headcount','country','email'] as const;
export type Lead = Record<(typeof columns)[number], string>;
export const fieldSchema = z.enum(['first_name','last_name','email','title','headcount']);
export type Field = z.infer<typeof fieldSchema>;
export const rulesSchema = z.object({
  industries: z.array(z.string().trim().min(1)), title_keywords: z.array(z.string().trim().min(1)),
  min_headcount: z.number().int().nonnegative().nullable(), max_headcount: z.number().int().nonnegative().nullable(),
  countries: z.array(z.string().trim().min(1)),
  priority_countries:z.array(z.string().trim().min(1)).default(priorityCountries),
  priority_industries:z.array(z.string().trim().min(1)).default(callHeavyIndustries),
  scoring_weights:weightsSchema.optional(),
}).strict().refine(r => r.min_headcount === null || r.max_headcount === null || r.min_headcount <= r.max_headcount, 'Minimum headcount must not exceed maximum');
export type Rules = z.infer<typeof rulesSchema>;
export const norm = (v: string) => v.normalize('NFKC').trim().toLowerCase();
export function emailIssues(email: string): string[] {
  const e = norm(email); const issues: string[] = [];
  const format=/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
  if (e.length>254 || (e.split('@')[0]?.length??0)>64 || !format.test(e)) issues.push('invalid_email');
  const [local, domain = ''] = e.split('@');
  if (/(^|\.)(example|test|invalid|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org)$/.test(domain)) issues.push('placeholder_email');
  if (/^(info|sales|support|contact|admin|office|hello|help|billing|team|careers|jobs|noreply|no-reply)([+._-].*)?$/.test(local)) issues.push('generic_mailbox');
  return issues;
}
export function matches(l: Lead, r: Rules): boolean {
  const inList = (values: string[], value: string) => !values.length || values.some(v => norm(v) === norm(value));
  const count = /^\d+$/.test(l.headcount) ? Number(l.headcount) : null;
  return inList(r.industries, l.industry) && inList(r.countries, l.country)
    && (!r.title_keywords.length || r.title_keywords.some(t => ['ceo','coo'].includes(norm(t))?new RegExp(`\\b${norm(t)}\\b`,'i').test(l.title):norm(l.title).includes(norm(t))))
    && (r.min_headcount === null || count !== null && count >= r.min_headcount)
    && (r.max_headcount === null || count !== null && count <= r.max_headcount);
}
export type Assessment = {
  method:'regex'; format_status:'valid'|'invalid'; name_pattern:'matches'|'does_not_match'|'insufficient_name_data';
  key: string; checked_at: string; deliverability: 'valid'|'invalid'|'accept_all'|'unknown'|'not_checked';
  mailbox_type: 'personal'|'generic'|'unknown'; identity: 'supported_match'|'conflict'|'unconfirmed';
  eligible: boolean; reasons: string[]; evidence: unknown;
};
export const candidateSchema = z.object({field: fieldSchema, value: z.string().trim().min(1).max(300),
  source_url: z.url().refine(u => /^https?:/.test(u)), excerpt: z.string().min(1).max(4000),
  identity_explanation: z.string().min(1).max(2000)}).strict();
export const researchSchema = z.object({candidates:z.array(candidateSchema).max(20), unresolved:z.array(z.object({field:fieldSchema,reason:z.string()}))});
export type Proposal = z.infer<typeof candidateSchema> & {id:string;lead_id:string;old_value:string;context: string;created_at:string;applied_at?:string};
export type State = { version:1; source:string; leads:Lead[]; proposals:Proposal[]; assessments:Record<string,Assessment>; history:Proposal[]; company_research:CompanyResearch[]; drafts?:SavedDraft[] };
export type SavedDraft = { lead_id:string; company:string; contact:string; title:string; to:string; subject:string; angle:'company'|'role'; body:string; ready_to_send:boolean; not_ready_reasons:string[]; corrections:string[]; drafted_at:string };
