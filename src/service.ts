import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { columns, emailIssues, matches, rulesSchema, type Lead, type State, type Field } from './model.ts';
import { Providers, ResearchNeededError, EnrichmentNeededError, companyInput, localAssessment } from './providers.ts';
import { researchInstructions, researchTarget, enrichmentInstructions, type Evidence, type ResearchTarget, type ContactEvidence, type EnrichmentTarget } from './research/evidence.ts';
import { Store } from './store.ts';
import { groups, selected, labels, handoffs } from './selection.ts';
import { otherProductRows, leadIssues } from './review.ts';
import { scoreCompany, scoreContact } from './scoring.ts';
import { angleFor, composeBody, needLine, subject, greeting as greet, tidyLead, draftsMarkdown, DEFAULT_SENDER, type Salutation } from './email.ts';
import { companyKey, companyResultSchema, eventFresh, researchFresh, type CompanyResearch } from './company.ts';

/** How Claude lays out its reply to a find_leads request; repeated in every result so it is not lost. */
export const RESPONSE_SECTIONS=[
  '1. Ranked leads: table of leads in rank order (rank, company, company score, contact name and title, contact score, main reasons, email status).',
  '2. Draft emails: call draft_email for each ranked lead in rank order (at most 10 unless the user asked for more) and show every draft exactly as returned, with not_ready_reasons when ready_to_send is false and lead_data_corrections when present.',
  '3. KrispCX / KrispAPI leads (important): ALWAYS a separate table under its own heading, never mixed into the KrispWork table or the drafts. One row per contact and product line from other_product_rows: product line, status (active = confirmed by research, potential = needs research), company, contact name and title, email, role suits product (yes/no), selected contact (yes/no), reason. If there are none, keep the heading and say none were found. Also downloadable as other-product-leads.csv.',
  '4. Suggestions: lead_issues (errors first, then warnings, grouped by issue with lead IDs and the suggested fix), plus pending proposals, research_warnings and any other useful next steps such as researching potential CX/API companies or running enrich_missing for missing fields. Do not change any lead without approval from the user.',
  '5. Downloads: end the reply by asking "Would you like to download your drafted emails? drafts.md (easy to read) or drafts.csv (spreadsheet)." and list any other files in downloads_available. Do not save, write or export these files on your own, and do not report a folder or path as the result. Only after the user says yes, call find_leads with download_files. Then hand over each returned file, with its exact name and content, using whatever your app offers for giving the user a downloadable file (file creation, an artifact, or a send-file or present-file tool). A temporary copy is fine if your app needs one to present the file, but never put it in the project folder or beside the leads file. If your app has no way to give a file, say so and show the content in a code block to copy.',
];
export const DOWNLOADS=['drafts.md','drafts.csv','lead-priorities.csv','other-product-leads.csv','handoffs.csv'] as const;
export type DownloadName=(typeof DOWNLOADS)[number];
export const DOWNLOAD_QUESTION='Would you like to download your drafted emails? drafts.md (easy to read) or drafts.csv (spreadsheet).';
export const DOWNLOAD_INSTRUCTIONS='Nothing is saved automatically. When the drafts are shown, end your reply with this question: "Would you like to download your drafted emails? drafts.md (easy to read) or drafts.csv (spreadsheet)." Also list any other files in downloads_available. Do not save, write or export these files on your own, and do not report a folder or path as the result. Only after the user says yes, call find_leads with download_files. Then hand over each returned file, with its exact name and content, using whatever your app offers for giving the user a downloadable file (file creation, an artifact, or a send-file or present-file tool). A temporary copy is fine if your app needs one to present the file, but never put it in the project folder or beside the leads file. If your app has no way to give a file, say so and show the content in a code block to copy.';
export class Service {
  public store:Store;
  private providers:Providers;
  private config:string;
  constructor(store:Store,providers=new Providers(),config='icp.json'){this.store=store;this.providers=providers;this.config=config;}
  private async rules(){return rulesSchema.parse(JSON.parse(await readFile(this.config,'utf8')));}
  async initialize(){try{await this.rules();}catch(e){await this.store.close();throw e;}}
  /**
   * One selected contact per eligible company (it passes the ICP rules and has a matching contact).
   * Ranked by company score, then contact score, then company headcount (unknown last), then CSV order.
   */
  private results(s:State,rules:Awaited<ReturnType<Service['rules']>>,order:'score'|'csv'='score'){
    const rows=groups(s).flatMap(g=>{const pick=selected(g,'krispwork',rules);if(!pick)return [];const label=labels(g,rules);const verification=this.assessment(pick.lead);
      // Company size is the largest headcount any of its contacts lists in the CSV.
      const sizes=g.members.map(m=>m.lead.headcount.trim()).filter(h=>/^\d+$/.test(h)).map(Number);
      const company_headcount=sizes.length?Math.max(...sizes):null;
      const company=scoreCompany({countries:g.members.map(m=>m.lead.country).filter(Boolean),industries:g.members.map(m=>m.lead.industry).filter(Boolean),company_headcount,top_lead:label.top_lead,krispwork_supported:label.product_fit.some(f=>f.product==='krispwork'&&f.status==='supported')},rules);
      const contact=scoreContact({lead:pick.lead,email_ready:verification.eligible},rules);
      return [{...pick.lead,...pick,lead:undefined,...label,verification,...company,...contact,company_headcount}];});
    const ranked=[...rows].sort((a,b)=>b.company_score-a.company_score||b.contact_score-a.contact_score||(b.company_headcount??-1)-(a.company_headcount??-1)).map((row,i)=>({rank:i+1,...row}));
    return order==='csv'?rows.map(r=>ranked.find(x=>x.lead_id===r.lead_id)!):ranked;
  }
  /**
   * Files the user can download. Built on request from the saved state and returned through the tool
   * (Claude offers them to the user); nothing is written next to the leads file.
   */
  async downloadFiles(names?:readonly DownloadName[]){
    const s=this.store.state;const rules=await this.rules();
    const table=(rows:unknown[],fields:string[])=>[fields,...rows.map(row=>fields.map(key=>{const v=(row as any)[key];return typeof v==='object'?JSON.stringify(v):String(v??'');}))].map(row=>row.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
    const drafts=s.drafts??[];
    const build:Record<DownloadName,()=>{description:string;mime_type:string;rows:number;content:string}>={
      'drafts.md':()=>({description:'Every email draft, easy to read (latest draft per lead)',mime_type:'text/markdown',rows:drafts.length,content:draftsMarkdown(drafts)}),
      'drafts.csv':()=>({description:'Every email draft as a spreadsheet',mime_type:'text/csv',rows:drafts.length,content:table(drafts,['lead_id','company','contact','title','to','subject','angle','ready_to_send','not_ready_reasons','corrections','drafted_at','body'])}),
      'lead-priorities.csv':()=>{const rows=this.results(s,rules);return {description:'Ranked KrispWork leads with scores and reasons',mime_type:'text/csv',rows:rows.length,content:table(rows,['rank','company_score','contact_score','company_score_reasons','contact_score_reasons','company_headcount','lead_id','company','first_name','last_name','title','email','company_id','top_lead','regional_fit','priority_countries_matched','priority_reasons','alternative_lead_ids','selection_reasons','readiness_issues'])};},
      'other-product-leads.csv':()=>{
        // KrispCX / KrispAPI leads, kept apart from the KrispWork list: one row per contact and product line.
        const rows=otherProductRows(s,rules).flatMap(r=>r.products.map(p=>({product_line:p.product==='krispcx'?'KrispCX':'KrispAPI',status:p.status,company:r.company,lead_id:r.lead_id,first_name:r.first_name,last_name:r.last_name,title:r.title,email:r.email,role_match:p.role_match,selected_contact:p.selected_contact,reason:p.reason})));
        return {description:'KrispCX and KrispAPI leads (separate from KrispWork)',mime_type:'text/csv',rows:rows.length,content:table(rows,['product_line','status','company','lead_id','first_name','last_name','title','email','role_match','selected_contact','reason'])};},
      'handoffs.csv':()=>{const rows=handoffs(s,rules);return {description:'KrispCX/KrispAPI handoffs per company, including stale and inactive history',mime_type:'text/csv',rows:rows.length,content:table(rows,['lead_id','company','product_line','status','company_id','contact_relevance','fit','researched_at','verification','alternative_lead_ids','selection_reasons'])};},
    };
    return DOWNLOADS.filter(n=>!names||names.includes(n)).map(n=>({filename:n,...build[n]()}));
  }
  /** What can be downloaded right now (no file contents), for Claude to offer to the user. */
  async downloadsAvailable(names?:readonly DownloadName[]){return (await this.downloadFiles(names)).filter(f=>f.rows>0).map(({content:_,...f})=>f);}
  lead(id:string,state=this.store.state){const l=state.leads.find(l=>l.lead_id===id);if(!l)throw new Error(`Unknown lead_id: ${id}`);return l;}
  assessment(l:Lead){return localAssessment(l);}
  async verify(id:string,_refresh=false){return this.store.transaction(async s=>this.verifyIn(this.lead(id,s),s));}
  private async verifyIn(l:Lead,s:State,_refresh=false){const a=localAssessment(l);s.assessments[a.key]=a;return a;}
  audit(ids?:string[]){
    const leads=ids?ids.map(id=>this.lead(id)):this.store.state.leads;
    return {total:leads.length,company_groups:groups(this.store.state).map(g=>({company_id:g.company_id,basis:g.basis,lead_ids:g.members.map(m=>m.lead.lead_id),suspected_duplicates:g.suspected_duplicates})),leads:leads.map(l=>({lead_id:l.lead_id,missing_fields:columns.filter(c=>!l[c]),email_issues:emailIssues(l.email),verification:this.assessment(l),research_context:l.first_name&&l.last_name?'named_person':emailIssues(l.email).length===0?'email_lookup':'company_only; person identity unresolved'}))};
  }
  async find(limit=20,order:'score'|'csv'='score'){const rules=await this.rules();return this.store.transaction(async s=>{const all=this.results(s,rules,order);return {order:order==='score'?'ranked by company_score, then contact_score, then company headcount':'CSV order',effective_rules:rules,matching_contacts:s.leads.filter(l=>matches(l,rules)).length,total_matches:all.length,unique_companies:all.length,returned_count:Math.min(limit,all.length),leads:all.slice(0,limit)};});}
  async listHandoffs(product?:'krispcx'|'krispapi',includeInactive=false,limit=20){const rules=await this.rules();return this.store.transaction(async s=>{const order=['active','potential','stale','inactive'];const rows=handoffs(s,rules).filter(h=>(!product||h.product_line===product)&&(includeInactive||h.status==='active'||h.status==='potential')).sort((a,b)=>order.indexOf(a.status)-order.indexOf(b.status));return {total_matches:rows.length,confirmed:rows.filter(h=>h.status==='active').length,potential:rows.filter(h=>h.status==='potential').length,handoffs:rows.slice(0,limit),download:'handoffs.csv'};});}
  // Public workflow orchestration; individual helpers are not registered as MCP tools.
  async prepareLeads(options:{order?:'score'|'csv';limit?:number;lead_ids?:string[];research?:boolean;enrich_missing?:boolean;approved_proposal_ids?:string[];company_evidence?:(Evidence&{lead_id:string})[];contact_evidence?:(ContactEvidence&{lead_id:string})[];download_files?:DownloadName[]}){
    if(options.download_files?.length)return {files:await this.downloadFiles(options.download_files),download_instructions:DOWNLOAD_INSTRUCTIONS};
    for(const id of [...options.lead_ids??[],...(options.company_evidence??[]).map(e=>e.lead_id),...(options.contact_evidence??[]).map(e=>e.lead_id)])this.lead(id);
    if(new Set((options.contact_evidence??[]).map(e=>e.lead_id)).size!==(options.contact_evidence??[]).length)throw new Error('Submit one contact_evidence entry per lead_id');
    const applied=options.approved_proposal_ids?await this.apply(options.approved_proposal_ids):undefined;
    const warnings:{lead_id:string;operation:string;message:string}[]=[];
    const requests:(ResearchTarget&{feedback?:string[]})[]=[];
    const researched=new Set<string>();
    const companyOf=(id:string)=>groups(this.store.state).find(g=>g.members.some(m=>m.lead.lead_id===id))!.company_id;
    // Evidence gathered by Claude is verified against the cited pages before anything is saved.
    for(const {lead_id,...evidence} of options.company_evidence??[]){
      if(researched.has(companyOf(lead_id)))continue;
      researched.add(companyOf(lead_id));
      try{const r=await this.researchCompany(lead_id,undefined,true,evidence);if(r.verification_feedback.length)warnings.push({lead_id,operation:'research_verification',message:r.verification_feedback.join(' | ')});}
      catch(e){if(e instanceof ResearchNeededError)requests.push({...e.target,feedback:e.feedback});else warnings.push({lead_id,operation:'research',message:e instanceof Error?e.message:'Company research failed'});}
    }
    // Contact evidence becomes proposals only; nothing is applied without explicit approval.
    const enrichRequests:EnrichmentTarget[]=[];
    const enriched=new Set<string>();
    const enrichOne=async(id:string,evidence?:ContactEvidence)=>{
      enriched.add(id);
      try{const r=await this.enrich(id,undefined,evidence);if(r.rejected.length)warnings.push({lead_id:id,operation:'enrichment_verification',message:r.rejected.join(' | ')});
        const blocked=r.unresolved.filter(u=>!r.proposals.some(p=>p.field===u.field));if(evidence&&blocked.length)warnings.push({lead_id:id,operation:'enrichment',message:blocked.map(u=>`${u.field}: ${u.reason}`).join(' | ')});
        else if(!evidence&&r.unresolved.length)warnings.push({lead_id:id,operation:'enrichment',message:r.unresolved.map(u=>`${u.field}: ${u.reason}`).join(' | ')});}
      catch(e){if(e instanceof EnrichmentNeededError)enrichRequests.push(e.target);else warnings.push({lead_id:id,operation:'enrichment',message:e instanceof Error?e.message:'Enrichment failed'});}
    };
    for(const {lead_id,...evidence} of options.contact_evidence??[])await enrichOne(lead_id,evidence);
    const initial=await this.find(options.limit??20,options.order);
    const targets=[...new Set([...(options.lead_ids??initial.leads.map(l=>l.lead_id)),...(options.company_evidence??[]).map(e=>e.lead_id),...(options.contact_evidence??[]).map(e=>e.lead_id)])];
    for(const id of targets){
      if(options.enrich_missing&&!enriched.has(id))await enrichOne(id);
      if(options.research&&!researched.has(companyOf(id))){
        researched.add(companyOf(id));
        try{await this.researchCompany(id);}
        catch(e){if(e instanceof ResearchNeededError)requests.push(e.target);else warnings.push({lead_id:id,operation:'research',message:e instanceof Error?e.message:'Company research failed'});}
      }
    }
    const result=options.research||options.enrich_missing||options.company_evidence||options.contact_evidence||applied?await this.find(options.limit??20,options.order):initial;
    const pending=this.store.state.proposals.filter(p=>targets.includes(p.lead_id)&&!p.applied_at&&p.context===JSON.stringify(this.lead(p.lead_id)));
    const companyResearch=groups(this.store.state).filter(g=>g.members.some(m=>targets.includes(m.lead.lead_id))).flatMap(g=>g.records.length?[{company_id:g.company_id,...g.records.at(-1)!}]:[]);
    return {...result,data_quality:this.audit(targets),company_research:companyResearch,proposals:pending,applied,handoffs:await this.listHandoffs(undefined,false,options.limit??20),other_product_rows:otherProductRows(this.store.state,await this.rules()),lead_issues:leadIssues(this.store.state),research_warnings:warnings,
      ...(requests.length?{research_requests:requests,research_instructions:researchInstructions()}:{}),
      ...(enrichRequests.length?{enrichment_requests:enrichRequests,enrichment_instructions:enrichmentInstructions()}:{}),
      response_sections:RESPONSE_SECTIONS,
      downloads_available:await this.downloadsAvailable(),download_instructions:DOWNLOAD_INSTRUCTIONS};
  }
  private researchNeeded(lead:Lead,website:string|undefined,feedback:string[]){
    return {status:'research_needed' as const,lead_id:lead.lead_id,message:`No current verified research for ${lead.company}. Research it with your web tools, then call draft_email again with the same arguments plus company_evidence. Do not write the email yourself.`,
      target:researchTarget(lead,companyInput(lead,website)),...(feedback.length?{verification_feedback:feedback}:{}),
      fallback:'If a quick search finds no public page clearly about this exact company (for example no website, a placeholder email domain, or only namesakes), call draft_email again with the same arguments plus personalization: "lead_data" to personalize from the lead\'s own CSV details instead. Do not invent company facts.',...researchInstructions()};
  }
  /**
   * Drafts are always produced (never sent): missing names or an unusable address become warnings and
   * ready_to_send:false. Personalization uses a verified company fact when available; otherwise Claude is
   * asked to research, or, with personalization "lead_data", the opener is built from the lead's CSV details.
   */
  async prepareDraft(id:string,sender:string=DEFAULT_SENDER,offer:string='',icebreakerId?:string,website?:string,evidence?:Evidence,personalization:'auto'|'lead_data'='auto',salutation?:Salutation){
    const lead=this.lead(id);
    if(!icebreakerId){
      let research;
      try{research=await this.researchCompany(id,website,Boolean(evidence),evidence);}
      catch(e){if(!(e instanceof ResearchNeededError))throw e;if(personalization==='lead_data')return {status:'drafted' as const,...await this.draft(id,sender,offer,null,salutation)};return this.researchNeeded(lead,website,e.feedback);}
      const candidate=research.candidates.find(c=>c.type==='company_fact'||eventFresh(c.event_date));
      if(!candidate){if(personalization==='lead_data')return {status:'drafted' as const,...await this.draft(id,sender,offer,null,salutation)};return this.researchNeeded(lead,website,[...research.verification_feedback,...research.unresolved]);}
      icebreakerId=candidate.id;
    }
    return {status:'drafted' as const,...await this.draft(id,sender,offer,icebreakerId,salutation)};
  }
  async enrich(id:string,fields?:Field[],evidence?:ContactEvidence){
    const snapshot=structuredClone(this.lead(id));
    // Fields that already have a pending, still-current proposal wait for the user's decision instead of being researched again.
    const pendingFields=new Set(this.store.state.proposals.filter(p=>p.lead_id===id&&!p.applied_at&&p.context===JSON.stringify(snapshot)).map(p=>p.field));
    const requested=fields??(['first_name','last_name','title','headcount','email'] as Field[]).filter(f=>(!snapshot[f] || f==='email'&&emailIssues(snapshot.email).length>0)&&(evidence||!pendingFields.has(f)));
    if(!requested.length)return {proposals:[],unresolved:[],rejected:[] as string[]};
    const result=await this.providers.research(snapshot,requested,evidence);
    return this.store.transaction(async s=>{
      if(JSON.stringify(this.lead(id,s))!==JSON.stringify(snapshot))throw new Error('Lead changed during research; research again');
      const proposals=result.candidates.filter(c=>requested.includes(c.field)&&c.value!==snapshot[c.field]).map(c=>{
        if(c.field==='headcount'&&!/^\d+$/.test(c.value))throw new Error('Research returned a headcount range or invalid number');
        return {...c,id:randomUUID(),lead_id:id,old_value:snapshot[c.field],context:JSON.stringify(snapshot),created_at:new Date().toISOString()};
      });
      s.proposals.push(...proposals);return {proposals,unresolved:result.unresolved,rejected:result.rejected??[]};
    });
  }
  async apply(ids:string[]){return this.store.transaction(async s=>{
    const proposals=[...new Set(ids)].map(id=>{const p=s.proposals.find(p=>p.id===id);if(!p)throw new Error(`Unknown proposal: ${id}`);return p;});
    const pending=proposals.filter(p=>!p.applied_at);const seen=new Set<string>();
    for(const p of pending){const l=this.lead(p.lead_id,s);const field=p.lead_id+':'+p.field;if(seen.has(field))throw new Error('Select only one proposal per field');seen.add(field);if(JSON.stringify(l)!==p.context || l[p.field]!==p.old_value)throw new Error(`Stale proposal ${p.id}; research again`);}
    for(const p of pending)this.lead(p.lead_id,s)[p.field]=p.value;
    // Verify the combined approved identity, so grouped name/email fixes are checked together.
    for(const id of new Set(pending.filter(p=>p.field==='email').map(p=>p.lead_id))){const a=await this.verifyIn(this.lead(id,s),s,true);if(!a.eligible)throw new Error(`Replacement email rejected: ${a.reasons.join('; ')}`);}
    for(const p of pending){p.applied_at=new Date().toISOString();s.history.push(structuredClone(p));}
    return {applied:pending.map(p=>p.id),already_applied:proposals.filter(p=>!pending.includes(p)).map(p=>p.id),export_path:this.store.enriched};
  });}
  async researchCompany(id:string,website?:string,refresh=false,evidence?:Evidence){
    const lead=structuredClone(this.lead(id));const key=companyKey(lead);
    const group=groups(this.store.state).find(g=>g.members.some(m=>m.lead.lead_id===id))!;
    const cached=[...group.records].reverse().find(r=>researchFresh(r.researched_at)&&(!website||r.company_website===website));
    if(cached&&!refresh){const rules=await this.rules();return {...cached,...labels(group,rules),top_lead:matches(lead,rules)&&labels(group,rules).top_lead,verification_feedback:[] as string[]};}
    const raw=await this.providers.researchCompany(lead,website,evidence);
    const feedback=raw.rejected??[];
    const result=companyResultSchema.parse(raw);
    // Unverified identity never adds findings; prior research keeps its original freshness.
    if(!result.identity_excerpt)throw new ResearchNeededError(researchTarget(lead,companyInput(lead,website)),[...feedback,...result.unresolved,...(group.records.length?['Previous findings were retained with their original freshness']:[])]);
    if(result.company_name.trim().toLowerCase()!==lead.company.trim().toLowerCase())throw new Error('Research company does not match lead');
    if((result.candidates.length||result.locations.length||result.product_fit.some(f=>f.status==='supported'))&&(!result.company_website||!result.identity_excerpt||!result.identity_source_url))throw new Error('Research lacks company identity evidence');
    const valid=result.candidates.filter(c=>c.type==='company_fact'||eventFresh(c.event_date));
    const events=valid.filter(c=>c.type==='recent_event');
    const record:CompanyResearch={...result,key,id:randomUUID(),researched_at:new Date().toISOString(),candidates:(events.length?events:valid).map(c=>({...c,id:randomUUID()}))};
    await this.store.transaction(async s=>{if(companyKey(this.lead(id,s))!==key)throw new Error('Company changed during research; research again');s.company_research.push(record);});
    const updated=groups(this.store.state).find(g=>g.members.some(m=>m.lead.lead_id===id))!;
    return {...record,...labels(updated,await this.rules()),top_lead:matches(lead,await this.rules())&&labels(updated,await this.rules()).top_lead,verification_feedback:feedback};
  }
  /** Keep the latest draft per lead in state, so drafts.md / drafts.csv can be built when the user downloads them. */
  private saveDraft<T extends {lead_id:string;to:string;subject:string;angle:'company'|'role';body:string;ready_to_send:boolean;not_ready_reasons?:string[];lead_data_corrections?:string[]}>(s:State,raw:Lead,l:Lead,result:T){
    s.drafts??=[];
    const saved={lead_id:result.lead_id,company:l.company,contact:`${l.first_name} ${l.last_name}`.trim(),title:l.title,to:result.to,subject:result.subject,angle:result.angle,body:result.body,ready_to_send:result.ready_to_send,not_ready_reasons:result.not_ready_reasons??[],corrections:result.lead_data_corrections??[],drafted_at:new Date().toISOString()};
    s.drafts=[...s.drafts.filter(d=>d.lead_id!==raw.lead_id),saved];
    return {...result,company:l.company,contact:`${l.first_name} ${l.last_name}`.trim(),drafts_so_far:s.drafts.length,downloads_available:['drafts.md','drafts.csv'],download_note:`After the last draft, end your reply with this question: "${DOWNLOAD_QUESTION}" ${'Do not save, write or export these files on your own, and do not report a folder or path as the result.'} Only after the user says yes, call find_leads with download_files and hand the files over as downloads.`};
  }
  async draft(id:string,sender:string=DEFAULT_SENDER,offer:string='',icebreakerId:string|null,salutation?:Salutation){
    sender=sender.trim()||DEFAULT_SENDER;
    return this.store.transaction(async s=>{
    const raw=this.lead(id,s);
    const a=await this.verifyIn(raw,s);
    // Tidy names, title and company for the email only; the leads file is not changed.
    const tidy=tidyLead(raw);const l=tidy.lead;const sal=salutation??tidy.salutation;
    const corrections=tidy.corrections.map(c=>`${c.field}: "${c.from}" → "${c.to}" (${c.why})`);
    const named=Boolean(l.first_name.trim()&&l.last_name.trim());
    const notReady=[...(a.eligible?[]:[`Email address not usable: ${a.reasons.filter(r=>!/not been verified|name pattern|resemble/i.test(r)).join(', ')||'failed local checks'}`]),...(named?[]:['Contact name incomplete'])];
    const greeting=greet(l,sal);
    const formality=sal?[]:[`Salutation unknown, so the greeting uses the full name; pass salutation (${'Mr, Ms, Mrs, Dr or Prof'}) for "Dear Mr ${l.last_name||'Surname'},"`];
    const angle=angleFor(l);
    const compose=(opener:string|null)=>composeBody({greeting,opener,lead:l,angle,offer,sender});
    const common={lead_id:id,to:raw.email,subject:subject(l,angle),angle,salutation:sal??null,...(corrections.length?{lead_data_corrections:corrections}:{}),ready_to_send:notReady.length===0,...(notReady.length?{not_ready_reasons:notReady}:{})};
    if(icebreakerId===null){
      const need=needLine(l,angle);
      const result={...common,body:compose(null),personalization:{basis:'lead_data' as const,fields_used:need.fields_used},sources:[] as {url:string;excerpt:string;event_date:string|null;researched_at:string}[],warnings:['Personalized from the lead\'s CSV details only; no verified company facts were used',...formality,...notReady,...a.reasons]};
      return this.saveDraft(s,raw,l,result);
    }
    const research=s.company_research.find(r=>r.candidates.some(c=>c.id===icebreakerId));
    if(!research)throw new Error('Unknown icebreaker_id; omit it to use current saved research, or research the company and supply company_evidence');
    if(!groups(s).find(g=>g.members.some(m=>m.lead.lead_id===id))?.records.some(r=>r.id===research.id))throw new Error('Icebreaker belongs to a different company');
    if(!researchFresh(research.researched_at))throw new Error('Company research expired; omit icebreaker_id and supply fresh company_evidence');
    const icebreaker=research.candidates.find(c=>c.id===icebreakerId)!;
    if(icebreaker.type==='recent_event'&&!eventFresh(icebreaker.event_date))throw new Error('Event is outside the last 90 days; omit icebreaker_id and supply fresh company_evidence');
    const result={...common,body:compose(icebreaker.icebreaker),icebreaker_id:icebreaker.id,personalization:{basis:'verified_research' as const,fields_used:needLine(l,angle).fields_used},sources:[{url:icebreaker.source_url,excerpt:icebreaker.excerpt,event_date:icebreaker.event_date,researched_at:research.researched_at}],warnings:[...formality,...notReady,...a.reasons]};
    return this.saveDraft(s,raw,l,result);
    });
  }
}
