import { createHash } from 'node:crypto';
import { companyDomain, companyKey, researchFresh, type CompanyResearch } from './company.ts';
import { norm, matches, type Lead, type State, type Rules } from './model.ts';
import { localAssessment } from './providers.ts';
import { country, type Fit } from './fit.ts';
import { products, cxIndustries, cxTitles, apiIndustries, apiTitles } from './fit.ts';

const nameKey=(value:string)=>norm(value).replace(/[^\p{L}\p{N}]/gu,'');
const host=(url:string|null)=>{try{return url?new URL(url).hostname.replace(/^www\./,''):'';}catch{return '';}};
export function groups(state:State){
 const recordIndex=new Map<string,CompanyResearch[]>();
 for(const record of state.company_research){if(!recordIndex.has(record.key))recordIndex.set(record.key,[]);recordIndex.get(record.key)!.push(record);}
 const details=state.leads.map((lead,index)=>{
  const records=recordIndex.get(companyKey(lead))??[];
  const resolved=[...records].reverse().find(r=>r.company_website&&r.identity_excerpt&&r.identity_source_url);
  const domain=companyDomain(lead);const corporate=domain&&!/^(gmail|yahoo|hotmail|outlook|icloud|live|aol|protonmail|proton)\./.test(domain)?domain:'';
  return {lead,index,name:nameKey(lead.company),resolved:host(resolved?.company_website??null),corporate};
 });
 const names=new Map<string,{members:typeof details;domains:Set<string>;verified:Set<string>}>();
 for(const d of details){if(!names.has(d.name))names.set(d.name,{members:[],domains:new Set(),verified:new Set()});const info=names.get(d.name)!;info.members.push(d);if(d.resolved||d.corporate)info.domains.add(d.resolved||d.corporate);if(d.resolved)info.verified.add(d.resolved);}
 const result=new Map<string,{company_id:string;basis:string;members:typeof details;records:CompanyResearch[];suspected_duplicates:string[]}>();
 for(const d of details){
  const info=names.get(d.name)!;const same=d.name?info.members:[];const domains=d.name?info.domains:new Set<string>();const verified=d.name?info.verified:new Set<string>();
  const domain=d.resolved||(verified.size===1&&domains.size===1?[...verified][0]:'');
  const key=domain?`domain:${domain}`:domains.size>1?`ambiguous:${d.name}:${d.corporate||d.lead.lead_id}`:`name:${d.name||d.lead.lead_id}`;
  if(!result.has(key))result.set(key,{company_id:createHash('sha256').update(key).digest('hex').slice(0,16),basis:domain?'researched_domain':domains.size>1?'conflicting_identity':'csv_name',members:[],records:[],suspected_duplicates:domains.size>1?same.map(o=>o.lead.lead_id):[]});
  result.get(key)!.members.push(d);
 }
 const recordGroups=new Map<string,Set<(typeof result extends Map<string,infer G>?G:never)>>();
 for(const group of result.values())for(const m of group.members){const key=companyKey(m.lead);if(!recordGroups.has(key))recordGroups.set(key,new Set());recordGroups.get(key)!.add(group);}
 for(const record of state.company_research)for(const group of recordGroups.get(record.key)??[])group.records.push(record);
 return [...result.values()];
}
export type Group=ReturnType<typeof groups>[number];
export const roleFit=(l:Lead,p:string)=>p==='krispwork'?true:p==='krispcx'?/support|customer|contact cent|call cent|operations|\bcoo\b|founder|\bceo\b/i.test(l.title):/engineer|developer|product|\bcto\b|technical|audio|voice|founder|\bceo\b/i.test(l.title);
const seniority=(l:Lead)=>/founder|chief|\b[cv]p\b|\bceo\b|\bcto\b|\bcoo\b/i.test(l.title)?4:/director|head/i.test(l.title)?3:/manager|lead/i.test(l.title)?2:l.title?1:0;
export function selected(group:Group,product:string,rules:Rules){
 const candidates=group.members.filter(m=>product==='krispwork'?matches(m.lead,rules):roleFit(m.lead,product));
 const latest=group.records.at(-1);
 const score=(l:Lead)=>[Number(localAssessment(l).eligible),Number(Boolean(l.first_name&&l.last_name)),Number(Boolean(l.first_name&&l.last_name&&researchFresh(latest?.researched_at??'')&&latest?.product_fit?.some(f=>f.product===product&&f.status==='supported'&&f.evidence.some(e=>norm(e.excerpt).includes(norm(`${l.first_name} ${l.last_name}`)))))),seniority(l)];
 candidates.sort((a,b)=>{const x=score(a.lead),y=score(b.lead);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return y[i]-x[i];return a.index-b.index;});
 if(!candidates.length)return null;
 const winner=candidates[0].lead;
 return {lead:winner,contact_relevance:product==='krispwork'?'end_user':'unknown',company_id:group.company_id,company_identity_basis:group.basis,selected_lead_id:winner.lead_id,alternative_lead_ids:group.members.filter(m=>m.lead.lead_id!==winner.lead_id).map(m=>m.lead.lead_id),selection_reasons:['Relevant product function','Local email readiness, complete names, source-backed role relevance, seniority, then CSV order'],readiness_issues:[...localAssessment(winner).reasons,...(!winner.first_name||!winner.last_name?['Both contact names are needed for drafting']:[])]};
}
/** Fit before any research: industry (or an explicit use-case title) can suggest potential; only research can confirm it. */
function unresearchedFit(group:Group,product:(typeof products)[number],rules:Rules){
 const none={product,status:'insufficient_evidence' as const,evidence:[] as {source_url:string;excerpt:string}[]};
 if(product==='krispwork')return group.members.some(m=>matches(m.lead,rules))?{...none,status:'potential' as const,reason:'Contact role matches the KrispWork rules; company use case needs research to confirm'}:{...none,reason:'No contact matches the KrispWork rules'};
 const [industries,titles,useCase]=product==='krispcx'?[cxIndustries,cxTitles,'contact-centre or customer phone operations']:[apiIndustries,apiTitles,'voice or audio built into its product'];
 const industry=group.members.map(m=>m.lead.industry).find(i=>i&&industries.some(x=>i.toLowerCase().includes(x.toLowerCase())));
 if(industry)return {...none,status:'potential' as const,reason:`Industry "${industry}" often has ${useCase}; needs research to confirm`};
 const title=group.members.map(m=>m.lead.title).find(t=>t&&titles.test(t));
 if(title)return {...none,status:'potential' as const,reason:`Contact title "${title}" points to ${useCase}; needs research to confirm`};
 return {...none,reason:`Nothing in the CSV suggests ${useCase}`};
}
export function labels(group:Group,rules:Rules){
 const latest=group.records.at(-1);const fresh=Boolean(latest&&researchFresh(latest.researched_at));
 const locations=fresh?latest?.locations??[]:[];
 const matched=locations.filter(l=>rules.priority_countries.map(country).includes(country(l.country)));
 const productFit=products.map(product=>latest?.product_fit?.find(f=>f.product===product)??unresearchedFit(group,product,rules));
 return {top_lead:matched.length>0,regional_fit:matched.length?'supported' as const:'unknown' as const,priority_countries_matched:[...new Set(matched.map(l=>country(l.country)))],priority_reasons:matched,product_fit:productFit,research_status:latest?(fresh?'current':'stale'):'not_researched'};
}
export function handoffs(state:State,rules:Rules){
 return groups(state).flatMap(group=>(['krispcx','krispapi'] as const).flatMap(product=>{
  const last=group.records.at(-1);const fit=last?.product_fit?.find(f=>f.product===product);
  const prior=[...group.records].reverse().find(r=>r.product_fit?.some(f=>f.product===product&&f.status==='supported'));
  if(!prior){
   // Not confirmed by research, but the industry or an explicit title suggests the product line.
   // Listed for every company, including ones without a KrispWork-matching contact.
   const label=labels(group,rules);const potential=label.product_fit.find(f=>f.product===product);
   if(potential?.status!=='potential')return [];
   const pick=selected(group,product,rules);
   return [{product_line:product,status:'potential' as string,...(pick?{...pick.lead,...pick,lead:undefined}:{lead_id:null,alternative_lead_ids:group.members.map(m=>m.lead.lead_id),selection_reasons:['No contact with a role matching this product line; research or find a contact']}),company_id:group.company_id,company:group.members[0].lead.company,contact_relevance:'unknown',fit:potential as Fit,researched_at:null as string|null,verification:pick?localAssessment(pick.lead):null,...label,top_lead:false}];
  }
  const pick=selected(group,product,rules);const original=fit?.status==='supported'?last!:prior;
  const status=fit?.status!=='supported'?'inactive':researchFresh(last!.researched_at)?'active':'stale';
  return [{product_line:product,status,...(pick?{...pick.lead,...pick,lead:undefined}:{lead_id:null,alternative_lead_ids:group.members.map(m=>m.lead.lead_id)}),company_id:group.company_id,company:group.members[0].lead.company,contact_relevance:product==='krispcx'&&pick&&/support|service/i.test(pick.lead.title)?'end_user':'unknown',fit:original.product_fit!.find(f=>f.product===product) as Fit,researched_at:original.researched_at as string|null,verification:pick?localAssessment(pick.lead):null,...labels(group,rules),top_lead:false}];
 }));
}
