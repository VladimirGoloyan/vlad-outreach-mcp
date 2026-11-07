import { columns, emailIssues, norm, type Rules, type State } from './model.ts';
import { localAssessment } from './providers.ts';
import { groups, handoffs, roleFit } from './selection.ts';

const freeMail=/^(gmail|googlemail|yahoo|hotmail|outlook|icloud|live|aol|protonmail|proton|gmx|mail|yandex)\./;

/**
 * Every CSV row at a company that fits KrispCX or KrispAPI (confirmed by research, or potential from
 * industry/title), not just the one selected contact. Rows are marked with each product they fit,
 * whether the row's role suits that product, and whether it is the contact chosen for the handoff.
 */
export function otherProductRows(state:State,rules:Rules){
  const byCompany=new Map(groups(state).map(g=>[g.company_id,g]));
  const rows=new Map<string,{lead_id:string;company:string;first_name:string;last_name:string;title:string;email:string;products:{product:'krispcx'|'krispapi';status:string;reason:string;role_match:boolean;selected_contact:boolean}[]}>();
  for(const h of handoffs(state,rules)){
    if(!['active','potential','stale'].includes(h.status))continue;
    const group=byCompany.get(h.company_id);if(!group)continue;
    for(const {lead} of group.members){
      if(!rows.has(lead.lead_id))rows.set(lead.lead_id,{lead_id:lead.lead_id,company:lead.company,first_name:lead.first_name,last_name:lead.last_name,title:lead.title,email:lead.email,products:[]});
      rows.get(lead.lead_id)!.products.push({product:h.product_line,status:h.status,reason:h.fit?.reason??'',role_match:roleFit(lead,h.product_line),selected_contact:h.lead_id===lead.lead_id});
    }
  }
  const order=['active','stale','potential'];
  const best=(r:{products:{status:string}[]})=>Math.min(...r.products.map(p=>order.indexOf(p.status)));
  return [...rows.values()].sort((a,b)=>best(a)-best(b)||a.company.localeCompare(b.company));
}

export type LeadIssue={lead_id:string;company:string;field:string;code:string;issue:string;severity:'error'|'warning';suggestion:string};

/** Data errors and suspicious values in the leads file, each with a suggested fix. Nothing is changed. */
export function leadIssues(state:State){
  const issues:LeadIssue[]=[];
  const add=(l:{lead_id:string;company:string},field:string,code:string,issue:string,severity:LeadIssue['severity'],suggestion:string)=>issues.push({lead_id:l.lead_id,company:l.company,field,code,issue,severity,suggestion});
  const emailCount=new Map<string,string[]>();const personCount=new Map<string,string[]>();
  for(const l of state.leads){
    const e=norm(l.email);if(e){if(!emailCount.has(e))emailCount.set(e,[]);emailCount.get(e)!.push(l.lead_id);}
    if(l.first_name.trim()&&l.last_name.trim()){const k=[l.first_name,l.last_name,l.company].map(norm).join('|');if(!personCount.has(k))personCount.set(k,[]);personCount.get(k)!.push(l.lead_id);}
  }
  for(const l of state.leads){
    for(const c of columns)if(c!=='lead_id'&&!l[c].trim())add(l,c,`missing_${c}`,`Missing ${c.replace('_',' ')}`,c==='email'||c==='company'?'error':'warning',c==='headcount'?'Add a numeric headcount; size rules and company score need it':`Fill in ${c.replace('_',' ')} (find_leads with enrich_missing:true can research it)`);
    if(l.email.trim()){
      const found=emailIssues(l.email);
      if(found.includes('invalid_email'))add(l,'email','invalid_email','Invalid email format','error','Correct the address; it cannot be sent to as written');
      if(found.includes('placeholder_email'))add(l,'email','placeholder_email','Placeholder email domain','error','Replace with the contact\'s real work address');
      if(found.includes('generic_mailbox'))add(l,'email','generic_mailbox','Generic mailbox (info@, sales@ …)','warning','Find the person\'s own address');
      const domain=norm(l.email).split('@')[1]??'';
      if(!found.includes('invalid_email')&&freeMail.test(domain))add(l,'email','free_email_provider','Personal/free email provider','warning','Prefer a work address at the company domain');
      if(!found.length&&localAssessment(l).name_pattern==='does_not_match')add(l,'email','email_name_mismatch','Email does not resemble the contact name','warning','Check that the email belongs to this person');
    }
    for(const f of ['first_name','last_name'] as const){const v=l[f].trim();
      if(v&&(/[0-9@]/.test(v)))add(l,f,'name_has_digits_or_at',`Name "${v}" contains digits or @`,'error','Fix the name; it looks like another field was pasted in');
      else if(v.length>2&&(v===v.toUpperCase()||v===v.toLowerCase())&&/\p{L}/u.test(v))add(l,f,'name_capitalisation',`Name "${v}" has unusual capitalisation`,'warning','Use normal capitalisation so the greeting reads naturally');}
    if(l.first_name.trim()&&l.last_name.trim()&&norm(l.first_name)===norm(l.last_name))add(l,'last_name','same_first_last_name','First and last name are identical','warning','Check the name columns');
    const dupes=emailCount.get(norm(l.email));if(dupes&&dupes.length>1&&dupes[0]!==l.lead_id)add(l,'email','duplicate_email',`Same email as ${dupes[0]}`,'warning','Duplicate row; remove or merge it');
    const k=[l.first_name,l.last_name,l.company].map(norm).join('|');const same=personCount.get(k);if(same&&same.length>1&&same[0]!==l.lead_id&&norm(l.email)!==norm(state.leads.find(x=>x.lead_id===same[0])!.email))add(l,'first_name','duplicate_person',`Same person and company as ${same[0]} with a different email`,'warning','Keep the row with the correct address');
  }
  for(const g of groups(state))if(g.suspected_duplicates.length)for(const m of g.members)add(m.lead,'company','conflicting_company_identity',`Company name shared with rows of different email domains (${g.suspected_duplicates.join(', ')})`,'warning','Check whether these are the same company or different companies with the same name');
  const severity={error:0,warning:1};
  const sorted=issues.sort((a,b)=>severity[a.severity]-severity[b.severity]);
  const byIssue:Record<string,number>={};for(const i of sorted)byIssue[i.code]=(byIssue[i.code]??0)+1;
  return {total:sorted.length,errors:sorted.filter(i=>i.severity==='error').length,warnings:sorted.filter(i=>i.severity==='warning').length,leads_affected:new Set(sorted.map(i=>i.lead_id)).size,by_issue:byIssue,issues:sorted.slice(0,150),...(sorted.length>150?{truncated:true}:{})};
}
