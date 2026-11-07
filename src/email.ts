// KrispWork email copy (formal tone).
// High-seniority contacts (founders, C-level, VPs, heads, directors) get the company angle: why their company needs Krisp,
// based on what the company does. Everyone else gets the role angle: why they need Krisp in their own day-to-day work.
// Lead fields are tidied for the email only (capitalisation, spacing, legal suffixes); the leads file is never changed.
import type { Lead, SavedDraft } from './model.ts';
import { SENIOR } from './scoring.ts';

export const DEFAULT_SENDER='Vlad';
export const MAX_WORDS=170;
export const SALUTATIONS=['Mr','Ms','Mrs','Dr','Prof'] as const;
export type Salutation=(typeof SALUTATIONS)[number];

export type Angle='company'|'role';
export const angleFor=(lead:Lead):Angle=>SENIOR.test(lead.title)?'company':'role';

// ---------- Tidying lead data for use in sentences ----------

const ACRONYMS=['CEO','COO','CTO','CFO','CMO','CRO','CIO','CISO','CHRO','CPO','CXO','VP','SVP','EVP','AVP','IT','HR','BDR','SDR','CX','AI','QA','UX','UI','PR','BPO','KPO','SaaS','CPaaS','B2B','B2C','EMEA','APAC','LATAM','US','UK','USA','GTM','RevOps','L&D','R&D','PMO','ERP','CRM','NOC','MSP','KYC'];
const ACRONYM=new Map(ACRONYMS.map(a=>[a.toLowerCase(),a]));
const SMALL=new Set(['of','and','the','for','at','in','to','on','a','an','or','with','&']);
const PARTICLES=new Set(['van','von','de','da','del','der','den','di','du','dos','das','la','le','bin','al']);
const LEGAL=/[,\s]+(inc\.?|incorporated|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|gmbh|s\.?a\.?|plc|pvt\.?\s*ltd\.?|private limited|co\.?|company)$/i;
const HONORIFIC=/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i;

const squash=(v:string)=>v.normalize('NFKC').replace(/\s+/g,' ').trim();
const oddCase=(v:string)=>/\p{L}/u.test(v)&&(v===v.toLowerCase()||v===v.toUpperCase());
const cap=(w:string)=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase();

function nameCase(v:string){
  return v.split(' ').map((word,i)=>word.split('-').map(part=>{
    const lower=part.toLowerCase();
    if(i>0&&PARTICLES.has(lower))return lower;
    if(/^o'/.test(lower))return "O'"+cap(lower.slice(2));
    if(/^mc./.test(lower))return 'Mc'+cap(lower.slice(2));
    return cap(lower);
  }).join('-')).join(' ');
}
/** Title Case for job titles: acronyms upper-cased, short joining words lower-cased. */
function titleCase(v:string,force:boolean){
  return v.split(' ').map((word,i)=>{
    const bare=word.replace(/[^\p{L}\p{N}&]/gu,'').toLowerCase();
    if(ACRONYM.has(bare))return word.replace(new RegExp(bare.replace(/[&]/g,'\\&'),'i'),ACRONYM.get(bare)!);
    if(!force)return word;
    if(i>0&&SMALL.has(bare))return word.toLowerCase();
    return word.split('-').map(cap).join('-');
  }).join(' ');
}
function companyCase(v:string){
  if(v===v.toLowerCase())return v.split(' ').map(w=>ACRONYM.get(w)??cap(w)).join(' ');
  // ALL CAPS names: keep short words (likely acronyms such as IBM), title-case the rest.
  if(v===v.toUpperCase())return v.split(' ').map(w=>w.replace(/[^\p{L}]/gu,'').length<=3?w:cap(w)).join(' ');
  return v;
}
/** Industry as it reads after "a/an": lower case, but acronyms kept (BPO, IT, HR, SaaS). */
function industryPhrase(v:string){return squash(v.split(/\s*\/\s*/)[0]??'').split(' ').map(w=>ACRONYM.get(w.toLowerCase().replace(/[^\p{L}\p{N}&]/gu,''))?w.replace(/[\p{L}\p{N}&]+/u,m=>ACRONYM.get(m.toLowerCase())??m):w.toLowerCase()).join(' ');}

/** "a" or "an", by the sound of the next word (an IT manager, an HR company, a user-research team, an insurance company). */
export function article(next:string){
  const word=next.trim().split(/[\s-]/)[0]??'';
  if(!word)return 'a';
  if(/^[A-Z]{2,}$/.test(word.replace(/[^A-Za-z]/g,''))&&word===word.toUpperCase())return /^[AEFHILMNORSX]/.test(word)?'an':'a';
  if(/^(hour|honest|honou?r|heir)/i.test(word))return 'an';
  if(/^(uni|use|usu|uti|ure|uro|one|eu)/i.test(word))return 'a';
  return /^[aeiou]/i.test(word)?'an':'a';
}

export type Correction={field:'first_name'|'last_name'|'title'|'company'|'industry';from:string;to:string;why:string};

/** A copy of the lead with fields cleaned for the email, plus a list of every change made and why. */
export function tidyLead(lead:Lead){
  const corrections:Correction[]=[];
  const out={...lead};
  const set=(field:Correction['field'],to:string,why:string)=>{if(to!==lead[field]){corrections.push({field,from:lead[field],to,why});out[field]=to;}};
  let salutation:Salutation|undefined;
  for(const f of ['first_name','last_name'] as const){
    let v=squash(lead[f]).replace(/[.,;]+$/,'');
    const h=f==='first_name'?v.match(HONORIFIC):null;
    if(h){const t=h[1].toLowerCase();salutation=t==='mr'?'Mr':t==='mrs'?'Mrs':t==='dr'?'Dr':t==='prof'?'Prof':'Ms';v=v.slice(h[0].length);}
    const fixed=oddCase(v)&&v.length>1?nameCase(v):v;
    set(f,fixed,h?'removed honorific from the name field':fixed!==v?'fixed capitalisation':'removed extra spaces or punctuation');
  }
  const title=squash(lead.title).replace(/[.,;]+$/,'');
  const titleFixed=titleCase(title,oddCase(title));
  set('title',titleFixed,titleFixed!==title?'fixed capitalisation':'removed extra spaces or punctuation');
  let company=squash(lead.company).replace(/[,;]+$/,'');
  const stripped=company.replace(LEGAL,'').trim();
  const legal=stripped&&stripped!==company;if(legal)company=stripped;
  const companyFixed=companyCase(company);
  set('company',companyFixed,legal?'dropped legal suffix for a natural sentence':companyFixed!==company?'fixed capitalisation':'removed extra spaces or punctuation');
  set('industry',squash(lead.industry),'removed extra spaces');
  return {lead:out,corrections,...(salutation?{salutation}:{})};
}

// ---------- Copy ----------

/** What a company in this industry spends its day on, phrased to follow "spends much of its day". */
const INDUSTRY_ACTIVITY:[RegExp,string][]=[
  [/logistic|supply chain|freight|shipping|transport/i,'coordinating shipments by phone with carriers, drivers and customers'],
  [/bpo|outsourc|call cent|contact cent|customer service/i,'handling high volumes of customer calls'],
  [/wealth|invest|asset management|advisor|adviser/i,'advising clients on their investments in calls and meetings'],
  [/insurance/i,'walking customers through policies and claims on calls'],
  [/financ|bank|lending|mortgage|fintech/i,'walking clients through loans, accounts and payments on calls'],
  [/recruit|staffing|\bhr\b|human resources|talent/i,'screening and interviewing candidates on calls'],
  [/consult|professional services|legal|law|accounting/i,'advising clients in calls and meetings'],
  [/real estate|property/i,'on calls with buyers, sellers and agents'],
  [/telecom/i,'supporting customers over the phone'],
  [/travel|hospitality|hotel/i,'helping guests and travellers by phone'],
  [/health ?tech|healthcare technology|health it/i,'on calls with healthcare customers and in remote meetings'],
  [/health|telehealth|medical|clinic/i,'speaking with patients on calls and virtual visits'],
  [/software|saas|technology|internet|\bit\b/i,'on calls with customers and in remote meetings'],
];

/** What a person in this role spends their day on, phrased to follow "spend most of your day". */
const ROLE_ACTIVITY:[RegExp,string][]=[
  [/sales|account exec|business development|\b[bs]dr\b/i,'on calls with prospects and customers'],
  [/customer|support|client|service/i,'on calls helping customers'],
  [/recruit|talent/i,'interviewing candidates'],
  [/consult/i,'on calls with clients'],
  [/\bit\b|help ?desk|service desk|technology/i,'on calls helping colleagues resolve issues'],
  [/operations|coordinator|dispatch/i,'coordinating with colleagues and partners on calls'],
];

const pick=(table:[RegExp,string][],text:string,fallback:string)=>table.find(([re])=>re.test(text))?.[1]??fallback;
const accentRelevant=(lead:Lead)=>/bpo|outsourc|call cent|contact cent|customer service/i.test(lead.industry)||/support|customer service|call/i.test(lead.title);

/** KrispWork features, phrased for the whole team (company angle) or for the contact personally (role angle). */
export function features(lead:Lead,angle:Angle){
  const team=angle==='company';
  return [
    `AI noise and background voice cancellation, so ${team?'every call your team makes':'every call you make'} sounds clear on both sides`,
    `AI meeting notes, transcripts and summaries, with no bot joining the call`,
    ...(accentRelevant(lead)?[`AI accent conversion for clearer conversations with ${team?'your customers':'customers'}`]:[]),
    `Works with Zoom, Google Meet, Microsoft Teams and other calling apps`,
  ];
}

/** The "why you need Krisp" paragraph. Expects a lead already passed through tidyLead. */
export function needLine(lead:Lead,angle:Angle){
  const company=lead.company.trim(),title=lead.title.trim(),industry=industryPhrase(lead.industry);
  if(angle==='company'){
    const activity=pick(INDUSTRY_ACTIVITY,`${industry} ${company}`,'in calls and meetings with customers and with each other');
    const kind=industry?(/\b(company|firm|agency|group|provider)$/i.test(industry)?industry:`${industry} company`):'';
    const line=company
      ?(kind?`As ${article(kind)} ${kind}, ${company} has a team that spends much of its day ${activity}.`:`The team at ${company} spends much of its day ${activity}.`)
      :`Your team likely spends much of its day ${activity}.`;
    return {line:`${line} Background noise, unclear audio and manual note-taking slow each of those conversations down.`,
      fields_used:['company',...(industry?['industry']:[])].filter(f=>f!=='company'||company)};
  }
  const activity=pick(ROLE_ACTIVITY,title,'in calls and meetings');
  const where=company?` at ${company}`:'';
  return {line:title?`As ${article(title)} ${title}${where}, you likely spend most of your day ${activity}, so a clear line and accurate notes matter on every call.`
      :`Your day${where} likely includes many calls and meetings, so a clear line and accurate notes matter on every call.`,
    fields_used:['title','company'].filter(f=>f!=='title'||title).filter(f=>f!=='company'||company)};
}

export function subject(lead:Lead,angle:Angle){
  const company=lead.company.trim();
  return angle==='company'?`Clearer calls across ${company||'your team'}`:`Clearer calls${company?` at ${company}`:''}, without the note-taking`;
}

export function meetingAsk(lead:Lead,angle:Angle){
  const company=lead.company.trim();
  return angle==='company'
    ?`Would you be available for a 15-minute meeting next week to see how KrispWork could support ${company||'your team'}?`
    :`Would you be available for a 15-minute meeting next week, so that I can show you how it fits into your day?`;
}

/** Formal greeting: "Dear Mr Smith," when the salutation is known, otherwise "Dear Jane Smith,". Never guessed from the first name. */
export function greeting(lead:Lead,salutation?:Salutation){
  const first=lead.first_name.trim(),last=lead.last_name.trim();
  if(salutation&&last)return `Dear ${salutation} ${last},`;
  if(first&&last)return `Dear ${first} ${last},`;
  if(first||last)return `Dear ${first||last},`;
  return 'Dear Sir or Madam,';
}

/** All saved drafts as one readable Markdown file. */
export function draftsMarkdown(drafts:SavedDraft[]){
  const one=(d:SavedDraft)=>{
    const meta=[`**To:** ${d.to||'(no email)'}`,`**Subject:** ${d.subject}`,`**Angle:** ${d.angle==='company'?'company (senior contact)':'role'}`,
      `**Ready to send:** ${d.ready_to_send?'yes':`no (${d.not_ready_reasons.join('; ')})`}`,...(d.corrections.length?[`**Lead data tidied:** ${d.corrections.join('; ')}`]:[])];
    return [`## ${d.company||'(no company)'}: ${d.contact||'(no name)'}${d.title?`, ${d.title}`:''}`,meta.join('  \n'),'```text\n'+d.body+'\n```'].join('\n\n');
  };
  return `# Email drafts (${drafts.length})\n\nDrafts only; nothing has been sent.\n\n${drafts.map(one).join('\n\n---\n\n')}\n`;
}

export function composeBody(input:{greeting:string;opener:string|null;lead:Lead;angle:Angle;offer?:string;sender:string}){
  const {lead,angle}=input;
  const need=needLine(lead,angle).line;
  const intro=angle==='company'?'KrispWork helps your whole team with:':'KrispWork helps you with:';
  const list=features(lead,angle).map(f=>`- ${f}`).join('\n');
  const parts=[input.greeting,[input.opener,need].filter(Boolean).join(' '),...(input.offer?.trim()?[input.offer.trim()]:[]),`${intro}\n${list}`,meetingAsk(lead,angle),`Kind regards,\n${input.sender}`];
  const body=parts.join('\n\n');
  if(body.split(/\s+/).length>=MAX_WORDS)throw new Error(`Offer and sender must keep the draft under ${MAX_WORDS} words`);
  return body;
}
