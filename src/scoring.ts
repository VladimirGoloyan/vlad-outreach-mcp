// Two-step scoring for KrispWork prospects:
//   1. company score - is this company worth targeting? (size, country, verified research)
//   2. contact score - is the contact we have there a good person to reach? (email, role, name)
// Leads are ranked by company score first; the contact score only orders companies with equal company scores.
import { z } from 'zod';
import { country } from './fit.ts';
import type { Lead, Rules } from './model.ts';

export const defaultWeights={
  // Company score
  company_size_large:20,   // company headcount 1000 or more
  company_size_mid:12,     // company headcount 200-999
  company_size_small:5,    // company headcount 50-199 (under 50 or unknown: 0)
  priority_country:10,     // a contact's CSV country is in priority_countries
  priority_industry:15,    // call-heavy industry: a contact's CSV industry contains an entry of priority_industries
  top_lead:20,             // verified research: current office/workforce in a priority country
  krispwork_supported:10,  // verified research supports KrispWork fit
  // Contact score
  email_ready:40,          // address passes local checks (real format, not generic, not a placeholder)
  senior_role:25,          // founder, C-level, VP, president, owner, managing director, head, director
  manager_role:15,         // manager, lead, supervisor
  other_matching_role:10,  // any other title that matches the KrispWork rules
  call_heavy_function:15,  // sales, customer support/success, recruiting, consulting, IT help desk
  complete_name:5,         // first and last name present
};
export type Weights=typeof defaultWeights;
export const weightsSchema=z.object(Object.fromEntries(Object.keys(defaultWeights).map(k=>[k,z.number().int().min(0).max(100).optional()])) as Record<keyof Weights,z.ZodOptional<z.ZodNumber>>).strict();

export const SENIOR=/founder|owner|president|chief|\b(ceo|coo|cto|cfo|cmo|cro|cio)\b|\bc[a-z]o\b|\bvp\b|vice president|managing director|\bhead\b|director/i;
const MANAGER=/manager|\blead\b|supervisor|team lead/i;
const CALL_HEAVY=/sales|account exec|business development|\bbdr\b|\bsdr\b|customer (support|service|success|experience)|support (agent|specialist|representative|rep)|client (services|success)|recruit|talent|consult|help ?desk|service desk|it support/i;

const weights=(rules:Rules)=>({...defaultWeights,...(rules.scoring_weights??{})} as Weights);
function tally(){
  const reasons:string[]=[];let score=0;
  return {add:(points:number,why:string)=>{if(points>0){score+=points;reasons.push(`+${points} ${why}`);}},note:(why:string)=>reasons.push(`+0 ${why}`),result:()=>({score,reasons})};
}

/** Step 1: how worth targeting the company is, from company facts only. */
export function scoreCompany(input:{countries:string[];industries?:string[];company_headcount:number|null;top_lead:boolean;krispwork_supported:boolean},rules:Rules){
  const w=weights(rules);const t=tally();
  const size=input.company_headcount;
  if(size!==null&&size>=1000)t.add(w.company_size_large,`large company (${size} people)`);
  else if(size!==null&&size>=200)t.add(w.company_size_mid,`mid-size company (${size} people)`);
  else if(size!==null&&size>=50)t.add(w.company_size_small,`small company (${size} people)`);
  else t.note(size===null?'company size unknown':`company size under 50 (${size} people)`);
  const priority=rules.priority_countries.map(country);
  const match=input.countries.map(country).find(c=>priority.includes(c));
  if(match)t.add(w.priority_country,`priority country (${match})`);
  const wanted=(rules.priority_industries??[]).map(i=>i.toLowerCase());
  const industry=(input.industries??[]).find(i=>wanted.some(p=>i.toLowerCase().includes(p)));
  if(industry)t.add(w.priority_industry,`call-heavy industry (${industry})`);
  if(input.top_lead)t.add(w.top_lead,'verified presence in a priority country');
  if(input.krispwork_supported)t.add(w.krispwork_supported,'verified KrispWork fit');
  const {score,reasons}=t.result();
  return {company_score:score,company_score_reasons:reasons};
}

/** Step 2: how good the contact we have at that company is. */
export function scoreContact(input:{lead:Lead;email_ready:boolean},rules:Rules){
  const w=weights(rules);const t=tally();const {lead}=input;
  if(input.email_ready)t.add(w.email_ready,'email ready to use');else t.note('email not ready (placeholder, generic or invalid)');
  if(SENIOR.test(lead.title))t.add(w.senior_role,`senior role (${lead.title})`);
  else if(MANAGER.test(lead.title))t.add(w.manager_role,`manager role (${lead.title})`);
  else if(lead.title)t.add(w.other_matching_role,`matching role (${lead.title})`);
  if(CALL_HEAVY.test(lead.title))t.add(w.call_heavy_function,'call-heavy function');
  if(lead.first_name&&lead.last_name)t.add(w.complete_name,'full name known');
  const {score,reasons}=t.result();
  return {contact_score:score,contact_score_reasons:reasons};
}
