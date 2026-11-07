import { z } from 'zod';
import { emailIssues, norm, type Lead } from './model.ts';
import { fitSchema, locationSchema } from './fit.ts';
export const companyCandidateSchema=z.object({type:z.enum(['recent_event','company_fact']),summary:z.string().trim().min(1).max(1000),event_date:z.string().nullable(),source_url:z.url().refine(u=>/^https?:/.test(u)),excerpt:z.string().min(1).max(4000),date_excerpt:z.string().nullable(),icebreaker:z.string().trim().min(1).refine(s=>!/[\r\n]/.test(s)&&s.split(/\s+/).length<=25)});
export const companyResultSchema=z.object({company_name:z.string(),company_website:z.url().nullable(),identity_excerpt:z.string().nullable(),identity_source_url:z.url().nullable(),candidates:z.array(companyCandidateSchema).max(3),unresolved:z.array(z.string()),product_fit:z.array(fitSchema).max(3).default([]),locations:z.array(locationSchema).max(30).default([])});
export type CompanyResult=z.infer<typeof companyResultSchema>;
export type CompanyResearch=Omit<z.infer<typeof companyResultSchema>,'product_fit'|'locations'|'candidates'>&{product_fit?:z.infer<typeof fitSchema>[];locations?:z.infer<typeof locationSchema>[];id:string;key:string;researched_at:string;candidates:(z.infer<typeof companyCandidateSchema>&{id:string})[]};
export const companyDomain=(l:Lead)=>emailIssues(l.email).some(i=>i!=='generic_mailbox')?undefined:norm(l.email).split('@')[1];
export const companyKey=(l:Lead)=>JSON.stringify([norm(l.company),norm(l.country),companyDomain(l)||'']);
export const researchFresh=(date:string)=>{const age=Date.now()-Date.parse(date);return age>=0&&age<7*86400_000;};
export function eventFresh(date:string|null){if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const time=Date.parse(date+'T00:00:00Z');const today=Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===date&&time<=today&&time>=today-90*86400_000;}
