import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Service } from '../src/service.ts';
import { Providers } from '../src/providers.ts';
import { serializeCsv, parseCsv } from '../src/csv.ts';
import type { Lead } from '../src/model.ts';
const lead:Lead={lead_id:'A',first_name:'Jane',last_name:'Smith',company:'Acme',country:'US',title:'Customer Support Agent',industry:'Software',headcount:'',email:'jane.smith@acme.com'};
const research=()=>({company_name:'Acme',company_website:'https://acme.com',identity_source_url:'https://acme.com',identity_excerpt:'Acme US',candidates:[{type:'company_fact' as const,summary:'Acme builds software',event_date:null,date_excerpt:null,source_url:'https://acme.com',excerpt:'Acme builds software',icebreaker:'I saw that Acme builds software.'}],unresolved:[],product_fit:[],locations:[]});
async function setup(leads=[lead]){
 const dir=await mkdtemp(join(tmpdir(),'public-workflow-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');await writeFile(source,serializeCsv(leads));await writeFile(config,await readFile('icp.json'));const store=new Store(source,join(dir,'data'));await store.init();const provider=new Providers();let calls=0;provider.researchCompany=async()=>{calls++;return research();};provider.research=async()=>{calls++;return {candidates:[],unresolved:[]};};return {store,provider,service:new Service(store,provider,config),calls:()=>calls};
}
test('find public workflow stays local by default; explicit research is deduplicated and returns selectable icebreakers',async()=>{
 const f=await setup([lead,{...lead,lead_id:'B',email:'other@acme.com'}]);try{
 const local=await f.service.prepareLeads({});assert.equal(f.calls(),0);assert.equal(local.unique_companies,1);assert(local.data_quality);assert(local.handoffs);assert(local.downloads_available.some((f:any)=>f.filename==='lead-priorities.csv'));assert(!local.downloads_available.some((f:any)=>f.filename==='drafts.md'));assert(!('files' in local));
 const researched=await f.service.prepareLeads({research:true,lead_ids:['A','B']});assert.equal(f.calls(),1);assert.equal(researched.company_research.length,1);assert.equal(researched.company_research[0].candidates.length,1);
 }finally{await f.store.close();}
});
test('public enrichment requires explicit proposal approval and keeps alternatives/source rows',async()=>{
 const f=await setup([{...lead,last_name:''}]);f.provider.research=async()=>({candidates:[{field:'last_name',value:'Smith',source_url:'https://acme.com',excerpt:'Jane Smith',identity_explanation:'Matches known person/company'}],unresolved:[]});try{
 const result=await f.service.prepareLeads({enrich_missing:true,lead_ids:['A']});assert.equal(result.proposals.length,1);assert.equal(f.store.state.leads[0].last_name,'');
 await f.service.prepareLeads({approved_proposal_ids:[result.proposals[0].id]});assert.equal(f.store.state.leads[0].last_name,'Smith');assert.equal(f.store.state.history.length,1);
 }finally{await f.store.close();}
});
test('draft public workflow checks readiness before APIs, researches internally, and reuses cached evidence',async()=>{
 const f=await setup();try{const draft=await f.service.prepareDraft('A','Sam','We help teams.');assert(draft.body.startsWith('Dear Jane Smith,'));assert(draft.sources.length);assert.equal(f.calls(),1);await f.service.prepareDraft('A','Sam','We help teams.');assert.equal(f.calls(),1);
 await f.store.transaction(async s=>{s.leads[0].email='info@acme.com';});const generic=await f.service.prepareDraft('A','Sam','Offer') as any;assert.equal(generic.status,'drafted');assert.equal(generic.ready_to_send,false);assert(generic.not_ready_reasons.some((r:string)=>/generic_mailbox/.test(r)));assert.equal(f.calls(),1);
 }finally{await f.store.close();}
});
test('research failures stay visible without breaking local lead results',async()=>{
 const f=await setup();f.provider.researchCompany=async()=>{throw Error('Research unavailable');};try{const r=await f.service.prepareLeads({research:true});assert.equal(r.unique_companies,1);assert.equal(r.research_warnings.length,1);assert.equal(f.store.state.company_research.length,0);}finally{await f.store.close();}
});
test('draft without saved research asks Claude to research, then drafts from verified evidence and reuses it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-research-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');await writeFile(source,serializeCsv([lead]));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();let fetches=0;
 const page='Acme | Home. Acme is a US company. Acme launched its new support desk for remote teams. More news.';
 const service=new Service(store,new Providers(async url=>{fetches++;return {url,markdown:page};}),config);
 try{
  const needed=await service.prepareDraft('A','Sam','We help teams.') as any;assert.equal(needed.status,'research_needed');assert.equal(fetches,0);assert(needed.how&&needed.rules.length);assert.equal(needed.target.known_domain,'acme.com');
  const evidence={company_website:'https://acme.com',identity_source_url:'https://acme.com/',identity_excerpt:'Acme is a US company',candidates:[{type:'company_fact' as const,summary:'Acme launched its new support desk for remote teams',source_url:'https://acme.com/',excerpt:'Acme launched its new support desk for remote teams.'}]};
  const rejected=await service.prepareDraft('A','Sam','We help teams.',undefined,undefined,{...evidence,candidates:[{...evidence.candidates[0],excerpt:'Acme invented teleportation.',summary:'Acme invented teleportation'}]}) as any;
  assert.equal(rejected.status,'research_needed');assert(rejected.verification_feedback.some((r:string)=>/verbatim/.test(r)));
  const drafted=await service.prepareDraft('A','Sam','We help teams.',undefined,undefined,evidence) as any;assert.equal(drafted.status,'drafted');assert(drafted.body.includes('I saw that Acme launched its new support desk for remote teams.'));assert.equal(drafted.sources[0].url,'https://acme.com/');
  const used=fetches;const again=await service.prepareDraft('A','Sam','We help teams.') as any;assert.equal(again.status,'drafted');assert.equal(fetches,used);
 }finally{await store.close();}
});
test('find research returns per-company research requests and accepts evidence keyed by lead id',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-find-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');await writeFile(source,serializeCsv([lead,{...lead,lead_id:'B',email:'other@acme.com'}]));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();
 const service=new Service(store,new Providers(async url=>({url,markdown:'Acme is a US company. Acme runs a 24/7 contact center for its customers.'})),config);
 try{
  const asked=await service.prepareLeads({research:true}) as any;assert.equal(asked.research_requests.length,1);assert.equal(asked.research_requests[0].company,'Acme');assert(asked.research_instructions.rules.length);assert.equal(store.state.company_research.length,0);
  const submitted=await service.prepareLeads({company_evidence:[{lead_id:'B',company_website:'https://acme.com',identity_source_url:'https://acme.com/',identity_excerpt:'Acme is a US company',candidates:[{type:'company_fact',summary:'Acme runs a 24/7 contact center for its customers',source_url:'https://acme.com/',excerpt:'Acme runs a 24/7 contact center for its customers.'}],product_fit:[{product:'krispcx',status:'supported',reason:'Runs a contact center',evidence:[{source_url:'https://acme.com/',excerpt:'Acme runs a 24/7 contact center for its customers.'}]}]}]}) as any;
  assert.equal(submitted.research_requests,undefined);assert.equal(store.state.company_research.length,1);assert.equal(submitted.company_research[0].candidates.length,1);assert(submitted.handoffs.handoffs.some((h:any)=>h.product_line==='krispcx'));
  const reused=await service.prepareLeads({research:true}) as any;assert.equal(reused.research_requests,undefined);
 }finally{await store.close();}
});
test('enrich_missing asks Claude for fields it can research and explains fields it cannot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-enrich-ask-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');
 await writeFile(source,serializeCsv([{...lead,email:'jane.smith@acme.example'},{...lead,lead_id:'B',first_name:'',last_name:'',headcount:'50',email:'support@acme.com'}]));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();let fetches=0;
 const service=new Service(store,new Providers(async url=>{fetches++;return {url,markdown:''};}),config);
 try{
  const r=await service.prepareLeads({lead_ids:['A','B'],enrich_missing:true}) as any;assert.equal(fetches,0);
  assert.equal(r.enrichment_requests.length,1);const req=r.enrichment_requests[0];assert.equal(req.lead_id,'A');assert.deepEqual(req.fields_needed.sort(),['email','headcount']);assert.match(req.identity_requirement,/Jane Smith/);assert(r.enrichment_instructions.rules.some((x:string)=>/Never guess/.test(x)));
  assert(r.research_warnings.some((w:any)=>w.lead_id==='B'&&/specific person/.test(w.message)));
 }finally{await store.close();}
});
test('contact evidence becomes proposals only when verified on the page, and applies only after approval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-enrich-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');
 await writeFile(source,serializeCsv([{...lead,email:'jane.smith@acme.example'}]));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();
 const pages:Record<string,string>={'https://acme.com/team':'Our team. Jane Smith, Head of Support at Acme. Email: jane.smith@acme.com','https://acme.com/about':'About Acme. Acme has 1,200 employees worldwide.'};
 const service=new Service(store,new Providers(async url=>{if(!pages[url])throw Error('HTTP 404');return {url,markdown:pages[url]};}),config);
 try{
  const email={field:'email' as const,value:'jane.smith@acme.com',source_url:'https://acme.com/team',excerpt:'Jane Smith, Head of Support at Acme. Email: jane.smith@acme.com',identity_explanation:'Acme team page names Jane Smith with this address'};
  const headcount={field:'headcount' as const,value:'1200',source_url:'https://acme.com/about',excerpt:'Acme has 1,200 employees worldwide.',identity_explanation:'Official Acme about page'};
  const guessed={field:'email' as const,value:'jsmith@acme.com',source_url:'https://acme.com/team',excerpt:'Email: jsmith@acme.com',identity_explanation:'Guessed pattern'};
  const bad=await service.prepareLeads({contact_evidence:[{lead_id:'A',candidates:[guessed]}]}) as any;
  assert.equal(bad.proposals.length,0);assert(bad.research_warnings.some((w:any)=>w.operation==='enrichment_verification'&&/verbatim/.test(w.message)));
  const r=await service.prepareLeads({contact_evidence:[{lead_id:'A',candidates:[email,headcount]}]}) as any;
  assert.equal(r.proposals.length,2);assert.equal(store.state.leads[0].email,'jane.smith@acme.example');
  // Pending proposals wait for the user instead of being researched again.
  const again=await service.prepareLeads({lead_ids:['A'],enrich_missing:true}) as any;assert.equal(again.enrichment_requests,undefined);
  await service.prepareLeads({approved_proposal_ids:r.proposals.map((p:any)=>p.id)});
  assert.equal(store.state.leads[0].email,'jane.smith@acme.com');assert.equal(store.state.leads[0].headcount,'1200');
  assert.equal(parseCsv(await readFile(source,'utf8'))[0].email,'jane.smith@acme.example');
 }finally{await store.close();}
});
test('lead_data personalization drafts from CSV details only, and verified research is still preferred',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lead-data-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');
 await writeFile(source,serializeCsv([{...lead,title:'VP of Sales',company:'Cloudhaven',industry:'Software',email:'jane.smith@cloudhaven.example'}]));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();let fetches=0;const service=new Service(store,new Providers(async url=>{fetches++;return {url,markdown:''};}),config);
 try{
  const asked=await service.prepareDraft('A','Sam','We help sales teams sound clear on every call.') as any;assert.equal(asked.status,'research_needed');assert.match(asked.fallback,/lead_data/);
  const d=await service.prepareDraft('A','Sam','We help sales teams sound clear on every call.',undefined,undefined,undefined,'lead_data') as any;
  assert.equal(d.status,'drafted');assert.equal(fetches,0);assert(d.body.startsWith('Dear Jane Smith,'));
  assert.equal(d.angle,'company');assert(d.body.includes('As a software company, Cloudhaven has a team that spends much of its day on calls with customers and in remote meetings.'));
  assert(d.body.includes('KrispWork helps your whole team with:'));assert(/meeting next week/.test(d.body));assert(d.body.endsWith('Kind regards,\nSam'));assert.equal(d.subject,'Clearer calls across Cloudhaven');
  assert.equal(d.ready_to_send,false);assert(d.not_ready_reasons.some((r:string)=>/placeholder_email/.test(r)));assert.deepEqual(d.sources,[]);assert.deepEqual(d.personalization.fields_used,['company','industry']);
  assert(d.body.split(/\s+/).length<170);
 }finally{await store.close();}
});
async function rankingFixture(rows:Lead[]){
 const dir=await mkdtemp(join(tmpdir(),'ranking-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');
 await writeFile(source,serializeCsv(rows));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();
 return {dir,config,store,service:new Service(store,new Providers(async()=>{throw Error('no network');}),config)};
}
test('company score ranks first; contact score only orders companies with equal company scores',async()=>{
 // Big: large UK company with a weak contact. Small: small German company with an excellent contact.
 const f=await rankingFixture([
  {...lead,lead_id:'S',company:'Small',headcount:'60',country:'Germany',title:'VP of Sales',email:'s.smith@small.com'},
  {...lead,lead_id:'B',company:'Big',headcount:'5000',country:'United Kingdom',title:'Operations Coordinator',email:'b@big.example'},
  {...lead,lead_id:'B2',company:'Big2',headcount:'5000',country:'United Kingdom',title:'Head of Customer Success',email:'b2@big2.example'}]);
 try{
  const r=await f.service.find(10);const by=Object.fromEntries(r.leads.map(l=>[l.lead_id,l]));
  assert.deepEqual(r.leads.map(l=>l.lead_id),['B2','B','S']);assert.deepEqual(r.leads.map(l=>l.rank),[1,2,3]);
  assert.equal(by.B.company_score,20+10);assert.equal(by.S.company_score,5);
  assert.equal(by.S.contact_score,40+25+15+5);assert.equal(by.B.contact_score,10+5);assert.equal(by.B2.contact_score,25+15+5);
  assert(by.B.company_score_reasons.some((x:string)=>/large company \(5000 people\)/.test(x)));assert(by.B.company_score_reasons.some((x:string)=>/priority country \(United Kingdom\)/.test(x)));
  assert(by.S.contact_score_reasons.some((x:string)=>/email ready/.test(x)));assert(!by.S.company_score_reasons.some((x:string)=>/email/.test(x)));
  assert.deepEqual((await f.service.find(10,'csv')).leads.map(l=>l.lead_id),['S','B','B2']);
  assert((await f.service.downloadFiles(['lead-priorities.csv']))[0].content.split('\n')[0].startsWith('"rank","company_score","contact_score"'));
 }finally{await f.store.close();}
});
test('company priority country counts any contact at the company; size tiers and custom weights apply',async()=>{
 const f=await rankingFixture([
  {...lead,lead_id:'A1',company:'Acme',headcount:'250',country:'Germany',title:'VP of Sales'},{...lead,lead_id:'A2',company:'Acme',headcount:'',country:'India',title:'Office Assistant'},
  {...lead,lead_id:'T',company:'Tiny',headcount:'20',country:'Germany',title:'VP of Sales'},{...lead,lead_id:'U',company:'Unknown',headcount:'',country:'Germany',title:'VP of Sales'}]);
 try{
  const r=await f.service.find(10);const by=Object.fromEntries(r.leads.map(l=>[l.lead_id,l]));
  assert.equal(by.A1.company_score,12+10);assert.equal(by.T.company_score,0);assert.equal(by.U.company_score,0);
  assert(by.T.company_score_reasons.some((x:string)=>/under 50/.test(x)));assert(by.U.company_score_reasons.some((x:string)=>/size unknown/.test(x)));
  // Equal company and contact scores: known headcount before unknown.
  assert.deepEqual(r.leads.map(l=>l.lead_id),['A1','T','U']);
  const rules=JSON.parse(await readFile(f.config,'utf8'));rules.scoring_weights={company_size_mid:0,priority_country:0};await writeFile(f.config,JSON.stringify(rules));
  assert.equal((await f.service.find(10)).leads.find(l=>l.lead_id==='A1')!.company_score,0);
 }finally{await f.store.close();}
});
test('equal company and contact scores rank the larger company first, unknown headcount last, then CSV order',async()=>{
 const base={...lead,title:'VP of Sales',country:'United Kingdom',email:'x@placeholder.example'};
 const f=await rankingFixture([{...base,lead_id:'S',company:'Small',headcount:'1001'},{...base,lead_id:'U',company:'Unknown',headcount:''},{...base,lead_id:'L',company:'Large',headcount:'3000'},{...base,lead_id:'M',company:'Mid',headcount:'1500'},{...base,lead_id:'M2',company:'Mid2',headcount:'1500'}]);
 try{const r=await f.service.find(10);assert.deepEqual(r.leads.map(l=>l.lead_id),['L','M','M2','S','U']);assert.deepEqual(r.leads.map(l=>l.company_headcount),[3000,1500,1500,1001,null]);}
 finally{await f.store.close();}
});
test('call-heavy industries add to the company score; lists are editable and partial matches count',async()=>{
 const f=await rankingFixture([
  {...lead,lead_id:'O',company:'Other',industry:'Manufacturing',headcount:'4200',country:'Netherlands',title:'VP of Sales'},
  {...lead,lead_id:'V',company:'Vertex',industry:'Logistics',headcount:'4200',country:'Netherlands',title:'Chief Operating Officer'},
  {...lead,lead_id:'T',company:'Trans',industry:'Transportation & Logistics',headcount:'',country:'Netherlands',title:'COO'},
  {...lead,lead_id:'I',company:'Insure',industry:'Insurance',headcount:'',country:'Netherlands',title:'COO'},
  {...lead,lead_id:'S',company:'Soft',industry:'Software',headcount:'',country:'Netherlands',title:'COO'}]);
 try{
  const r=await f.service.find(10);const by=Object.fromEntries(r.leads.map(l=>[l.lead_id,l]));
  assert.equal(by.V.company_score,20+15);assert.equal(by.O.company_score,20);assert.equal(by.T.company_score,15);assert.equal(by.I.company_score,15);assert.equal(by.S.company_score,0);
  assert(by.V.company_score_reasons.some((x:string)=>/call-heavy industry \(Logistics\)/.test(x)));
  assert.equal(r.leads[0].lead_id,'V');assert.equal(r.leads.at(-1)!.lead_id,'S');
  // Rules without the key (datasets from earlier versions) get the default list.
  const rules=JSON.parse(await readFile(f.config,'utf8'));delete rules.priority_industries;await writeFile(f.config,JSON.stringify(rules));
  assert.equal((await f.service.find(10)).leads.find(l=>l.lead_id==='I')!.company_score,15);
  rules.priority_industries=['Manufacturing'];await writeFile(f.config,JSON.stringify(rules));
  assert.deepEqual((await f.service.find(10)).leads.slice(0,2).map(l=>l.lead_id),['O','V']);
 }finally{await f.store.close();}
});
test('potential CX/API opportunities are listed in handoffs, including companies without a KrispWork contact',async()=>{
 const f=await rankingFixture([
  {...lead,lead_id:'G',company:'Fable Games',industry:'Gaming',headcount:'420',country:'France',title:'Junior Designer'},
  {...lead,lead_id:'B',company:'Echo',industry:'BPO / Outsourcing',headcount:'3100',country:'India',title:'Head of Operations'},
  {...lead,lead_id:'S',company:'Soft',industry:'Software',headcount:'300',country:'India',title:'COO'}]);
 try{
  const r=await f.service.prepareLeads({limit:10}) as any;
  assert.deepEqual(r.leads.map((l:any)=>l.lead_id).sort(),['B','S']);
  const h=r.handoffs.handoffs;assert.equal(r.handoffs.potential,2);assert.equal(r.handoffs.confirmed,0);
  const game=h.find((x:any)=>x.company==='Fable Games');assert.equal(game.product_line,'krispapi');assert.equal(game.status,'potential');assert.equal(game.lead_id,null);assert.deepEqual(game.alternative_lead_ids,['G']);assert.match(game.fit.reason,/Gaming/);
  const bpo=h.find((x:any)=>x.company==='Echo');assert.equal(bpo.product_line,'krispcx');assert.equal(bpo.lead_id,'B');
  assert(!h.some((x:any)=>x.company==='Soft'));
  assert((await f.service.downloadFiles(['handoffs.csv']))[0].content.includes('"potential"'));
 }finally{await f.store.close();}
});
test('junior contacts get a role-angle email with KrispWork features, a meeting ask and the default Vlad signature',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'role-angle-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');
 await writeFile(source,serializeCsv([{...lead,title:'Customer Support Agent',company:'Helpline',industry:'BPO',email:'jane.smith@helpline.example'}]));await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();const service=new Service(store,new Providers(async()=>{throw Error('no network');}),config);
 try{
  const d=await service.prepareDraft('A',undefined,undefined,undefined,undefined,undefined,'lead_data') as any;
  assert.equal(d.status,'drafted');assert.equal(d.angle,'role');
  assert(d.body.includes('As a Customer Support Agent at Helpline, you likely spend most of your day on calls helping customers'));
  assert(d.body.includes('KrispWork helps you with:'));assert(/accent conversion/.test(d.body));assert(/noise and background voice cancellation/.test(d.body));
  assert(/15-minute meeting next week/.test(d.body));assert(d.body.endsWith('Kind regards,\nVlad'));assert.deepEqual(d.personalization.fields_used,['title','company']);
 }finally{await store.close();}
});
test('find_leads marks every row fitting other products and lists lead errors with suggested fixes',async()=>{
 const f=await rankingFixture([
  {...lead,lead_id:'B',company:'Echo',industry:'BPO / Outsourcing',headcount:'3100',country:'India',title:'Head of Operations',email:'jane.smith@echo.com'},
  {...lead,lead_id:'C',first_name:'Raj',last_name:'Patel',company:'Echo',industry:'BPO / Outsourcing',headcount:'3100',country:'India',title:'Customer Support Manager',email:'raj.patel@echo.com'},
  {...lead,lead_id:'S',company:'Soft',industry:'Software',headcount:'300',country:'India',title:'COO',email:'info@soft.com'},
  {...lead,lead_id:'D',company:'Soft',industry:'Software',headcount:'300',country:'India',title:'COO',first_name:'JANE',email:'info@soft.com'},
  {...lead,lead_id:'X',company:'Nowhere',industry:'Software',headcount:'300',country:'India',title:'CEO',last_name:'',email:'bad-email'}]);
 try{
  const r=await f.service.prepareLeads({limit:10}) as any;
  assert.equal(r.response_sections.length,5);assert.match(r.response_sections[4],/download/);assert.match(r.response_sections[1],/draft_email/);
  const rows=r.other_product_rows;assert.deepEqual(rows.map((x:any)=>x.lead_id).sort(),['B','C']);
  const c=rows.find((x:any)=>x.lead_id==='C').products[0];assert.equal(c.product,'krispcx');assert.equal(c.status,'potential');assert.equal(c.role_match,true);
  const codes=(id:string)=>r.lead_issues.issues.filter((i:any)=>i.lead_id===id).map((i:any)=>i.code);
  assert(codes('X').includes('invalid_email'));assert(codes('X').includes('missing_last_name'));
  assert(codes('S').includes('generic_mailbox'));
  assert(codes('D').includes('duplicate_email'));assert(codes('D').includes('name_capitalisation'));
  assert.equal(r.lead_issues.issues[0].severity,'error');assert(r.lead_issues.by_issue.invalid_email>=1);
  assert(r.lead_issues.issues.every((i:any)=>i.suggestion));
 }finally{await f.store.close();}
});
test('server instructions ask for drafts, other-product rows and suggestions in the reply',async()=>{
 const {serverInstructions}=await import('../src/server.ts');const g=serverInstructions();
 assert.match(g,/Draft emails/);assert.match(g,/other_product_rows/);assert.match(g,/lead_issues/);
});
test('formal greeting, tidied lead data, saved drafts and a separate KrispCX/KrispAPI export',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'formal-')),source=join(dir,'leads.csv'),config=join(dir,'icp.json');
 await writeFile(source,serializeCsv([
  {...lead,lead_id:'F',first_name:'  JOHN ',last_name:"o'brien",title:'it manager',company:'northwind  analytics, inc.',industry:'Software',email:'john.obrien@northwind.example'},
  {...lead,lead_id:'D',first_name:'Mr. Raj',last_name:'Patel',title:'vp of sales',company:'ACME LOGISTICS',industry:'Logistics',email:'raj.patel@acmelogistics.example'},
  {...lead,lead_id:'C',first_name:'Ana',last_name:'Lopez',title:'Contact Center Manager',company:'Echo',industry:'BPO',email:'ana.lopez@echo.example'}]));
 await writeFile(config,await readFile('icp.json'));
 const store=new Store(source,join(dir,'data'));await store.init();const service=new Service(store,new Providers(async()=>{throw Error('no network');}),config);
 try{
  const f=await service.prepareDraft('F',undefined,undefined,undefined,undefined,undefined,'lead_data') as any;
  assert(f.body.startsWith("Dear John O'Brien,"));assert(f.body.includes('As an IT Manager at Northwind Analytics, you likely spend'));
  assert.equal(f.salutation,null);assert(f.warnings.some((w:string)=>/Salutation unknown/.test(w)));assert(f.lead_data_corrections.some((c:string)=>/legal suffix/.test(c)));
  const withSal=await service.prepareDraft('F',undefined,undefined,undefined,undefined,undefined,'lead_data','Mr') as any;assert(withSal.body.startsWith("Dear Mr O'Brien,"));
  const d=await service.prepareDraft('D',undefined,undefined,undefined,undefined,undefined,'lead_data') as any;
  assert.equal(d.angle,'company');assert(d.body.startsWith('Dear Mr Patel,'));assert(d.body.includes('As a logistics company, Acme Logistics has a team'));assert.equal(d.subject,'Clearer calls across Acme Logistics');
  assert.equal(store.state.leads.find(l=>l.lead_id==='D')!.first_name,'Mr. Raj','the leads file is never changed');
  assert.deepEqual(d.downloads_available,['drafts.md','drafts.csv']);assert(d.download_note.includes('Would you like to download your drafted emails?'));assert(/Do not save/.test(d.download_note));
  const got=await service.prepareLeads({download_files:['drafts.md','drafts.csv']}) as any;assert.deepEqual(Object.keys(got).sort(),['download_instructions','files']);
  const md=got.files[0].content;assert.equal(got.files[0].mime_type,'text/markdown');assert(md.startsWith('# Email drafts (2)'));assert(md.includes("Dear Mr O'Brien,"));assert(md.includes('Dear Mr Patel,'));
  assert(got.files[1].content.split('\r\n')[0].startsWith('"lead_id","company","contact"'));
  const r=await service.prepareLeads({limit:10}) as any;
  assert(r.downloads_available.some((f:any)=>f.filename==='other-product-leads.csv'&&f.rows>0));assert(r.download_instructions.includes('Would you like to download your drafted emails?'));assert(/never put it in the project folder/.test(r.download_instructions));
  const other=(await service.prepareLeads({download_files:['other-product-leads.csv']}) as any).files[0].content;assert(other.split('\r\n')[0].startsWith('"product_line","status","company"'));assert(other.includes('"KrispCX","potential","Echo","C"'));
 }finally{await store.close();}
});
test('no derived files are written to disk; only the lead data itself is saved',async()=>{
 const f=await rankingFixture([{...lead,lead_id:'S',company:'Small',headcount:'60',country:'Germany',title:'VP of Sales',email:'s.smith@small.com'}]);
 try{
  await f.service.prepareLeads({limit:5});await f.service.prepareDraft('S',undefined,undefined,undefined,undefined,undefined,'lead_data');
  const {readdir}=await import('node:fs/promises');const written=[...await readdir(f.dir),...await readdir(join(f.dir,'data'))];
  for(const name of ['drafts.md','drafts.csv','lead-priorities.csv','handoffs.csv','other-product-leads.csv'])assert(!written.includes(name),`${name} must not be written`);
 }finally{await f.store.close();}
});
test('activity lines describe each kind of tool result in plain language',async()=>{
 const {startMessage,finishMessage}=await import('../src/activity.ts');
 assert.equal(startMessage('find_leads',{}),'Reading the leads file and ranking companies');
 assert.equal(startMessage('find_leads',{company_evidence:[{}]}),'Checking research for 1 company against the cited pages');
 assert.equal(startMessage('find_leads',{download_files:['drafts.md']}),'Preparing drafts.md');
 assert.equal(finishMessage('find_leads',{total_matches:23,leads:[1,2],other_product_rows:[1],lead_issues:{total:4}}),'Ranked 23 companies, showing the top 2, 1 KrispCX/KrispAPI row, 4 data issues');
 assert.equal(finishMessage('find_leads',{files:[{filename:'drafts.md'}]}),'Ready to download: drafts.md');
 assert.equal(finishMessage('draft_email',{status:'research_needed',target:{company:'Acme'}}),'Company research needed before drafting for Acme');
 assert.equal(finishMessage('draft_email',{status:'drafted',contact:'Jane Smith',company:'Acme',angle:'company',drafts_so_far:3}),'Email drafted for Jane Smith at Acme (company angle). 3 drafts so far');
});
