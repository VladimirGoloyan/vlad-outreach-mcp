import type { z } from 'zod';
import { companyDomain } from './company.ts';
import type { CompanyResult } from './research/company-research.ts';
import { fetchSource, type FetchPage } from './research/sources.ts';
import { verifyEvidence, researchTarget, verifyContactEvidence, enrichmentTarget, type Evidence, type ResearchTarget, type ContactEvidence, type EnrichmentTarget } from './research/evidence.ts';
import { researchableFields } from './research/research.ts';
import { emailIssues, norm, researchSchema, type Assessment, type Lead, type Field } from './model.ts';

export const verificationKey=(l:Lead)=>JSON.stringify([norm(l.email),norm(l.first_name),norm(l.last_name),norm(l.company)]);
export function localAssessment(l:Lead):Assessment {
  const issues=emailIssues(l.email);
  const cleanName=(value:string)=>norm(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const first=cleanName(l.first_name),last=cleanName(l.last_name);
  const local=norm(l.email).split('@')[0].split('+')[0].replace(/[._-]/g,'');
  const name_pattern=!first||!last?'insufficient_name_data':new Set([first+last,first[0]+last,first+last[0],last+first]).has(local)?'matches':'does_not_match';
  const reasons=[...issues,'Mailbox existence, deliverability, and ownership have not been verified'];
  if(name_pattern==='does_not_match')reasons.push('Email does not resemble the contact name; this is advisory only');
  if(name_pattern==='insufficient_name_data')reasons.push('Insufficient name data for a name-pattern check');
  return {key:verificationKey(l),checked_at:new Date().toISOString(),method:'regex',format_status:issues.includes('invalid_email')?'invalid':'valid',name_pattern,deliverability:'not_checked',mailbox_type:issues.includes('generic_mailbox')?'generic':'unknown',identity:'unconfirmed',eligible:issues.length===0,reasons,evidence:null};
}
export class ResearchNeededError extends Error {
  readonly target:ResearchTarget; readonly feedback:string[];
  constructor(target:ResearchTarget,feedback:string[]=[]){super(`No current verified research for ${target.company}; research it with your web tools and resubmit with company_evidence.`);this.target=target;this.feedback=feedback;}
}
export class EnrichmentNeededError extends Error {
  readonly target:EnrichmentTarget;
  constructor(target:EnrichmentTarget){super(`Missing or defective fields for lead ${target.lead_id}; research them with your web tools and resubmit with contact_evidence.`);this.target=target;}
}
export const companyInput=(lead:Lead,company_website?:string)=>({company:lead.company,country:lead.country,domain:companyDomain(lead),company_website});
export class Providers {
  private fetchPage:FetchPage;
  constructor(fetchPage:FetchPage=fetchSource) {this.fetchPage=fetchPage;}
  async verify(l:Lead):Promise<Assessment> {return localAssessment(l);}
  /** Verify Claude-supplied contact evidence against the cited pages. Without evidence, ask Claude to research. */
  async research(lead:Lead,fields:Field[],evidence?:ContactEvidence):Promise<z.infer<typeof researchSchema>&{rejected?:string[]}> {
    const {allowed,unresolved}=researchableFields(lead,fields);
    if(!allowed.length)return {candidates:[],unresolved:unresolved as z.infer<typeof researchSchema>['unresolved']};
    if(!evidence)throw new EnrichmentNeededError(enrichmentTarget(lead,fields));
    return verifyContactEvidence(lead,fields,evidence,this.fetchPage);
  }
  /** Verify Claude-supplied evidence against the cited pages. Without evidence, ask Claude to research. */
  async researchCompany(lead:Lead,company_website?:string,evidence?:Evidence):Promise<CompanyResult&{rejected?:string[]}>{
    const input=companyInput(lead,company_website);
    if(!evidence)throw new ResearchNeededError(researchTarget(lead,input));
    return verifyEvidence(input,evidence,this.fetchPage);
  }
}
