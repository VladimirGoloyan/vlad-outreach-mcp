import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchCompany, recentEvent } from '../src/research/company-research.ts';
import { Providers, ResearchNeededError } from '../src/providers.ts';
import { evidenceSchema } from '../src/research/evidence.ts';
import { Service } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { serializeCsv } from '../src/csv.ts';
import type { Lead } from '../src/model.ts';
import { companyKey, type CompanyResult } from '../src/company.ts';

const lead:Lead={lead_id:'P1',first_name:'Jane',last_name:'Smith',company:'Acme',country:'US',email:'jane@acme.com',title:'Head of IT',headcount:'100',industry:'Software'};
const today=()=>new Date().toISOString().slice(0,10);
const result=():CompanyResult=>({company_name:'Acme',company_website:'https://acme.com',identity_excerpt:'Acme US',identity_source_url:'https://acme.com',candidates:[{type:'recent_event',summary:'Acme launched Atlas',event_date:today(),source_url:'https://acme.com/news',excerpt:'Acme launched Atlas',date_excerpt:today(),icebreaker:'I noticed Acme launched Atlas.'}],unresolved:[]});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'company-test-'));const source=join(dir,'leads.csv');await writeFile(source,serializeCsv([lead]));const store=new Store(source,join(dir,'data'));await store.init();
 const p=new Providers();let calls=0;p.researchCompany=async()=>{calls++;return result();};
 return {dir,source,store,p,service:new Service(store,p),calls:()=>calls};
}
test('company results are cached, selectable, attributed, shared only by company, and persisted',async()=>{
 const {store,service,calls,source,dir}=await fixture();try{
 const r=await service.researchCompany('P1');await service.researchCompany('P1');assert.equal(calls(),1);await service.researchCompany('P1',undefined,true);assert.equal(calls(),2);
 const d=await service.draft('P1','Sam','We help improve onboarding.',r.candidates[0].id);assert(d.body.startsWith('Dear Jane Smith,'));assert(d.body.includes(r.candidates[0].icebreaker));assert(d.body.split(/\s+/).length<170);assert(!d.body.includes('https://'));assert.equal(d.sources[0].url,'https://acme.com/news');assert(d.warnings.some(w=>w.includes('not been verified')));
 await assert.rejects(service.draft('P1','Sam',Array(170).fill('word').join(' '),r.candidates[0].id),/170 words/);
 await store.close();const reopened=new Store(source,join(dir,'data'));await reopened.init();assert.equal(reopened.state.company_research.length,2);await reopened.close();
 }finally{await store.close();}
});
test('draft rejects missing names, unknown selections, changed company, old research and expired events',async()=>{
 const {store,service}=await fixture();try{
 await assert.rejects(service.draft('P1','Sam','Offer','unknown'),/Unknown icebreaker/);const r=await service.researchCompany('P1');const id=r.candidates[0].id;
 await store.transaction(async s=>{s.leads[0].last_name='';});const partial=await service.draft('P1','Sam','Offer',id);assert.equal(partial.ready_to_send,false);assert(partial.not_ready_reasons!.some(r=>/name/.test(r)));assert(partial.body.startsWith('Dear Jane,'));
 await store.transaction(async s=>{s.leads[0].last_name='Smith';s.leads[0].company='Other';});await assert.rejects(service.draft('P1','Sam','Offer',id),/different company/);
 await store.transaction(async s=>{s.leads[0].company='Acme';s.company_research[0].researched_at='2000-01-01';});await assert.rejects(service.draft('P1','Sam','Offer',id),/expired/);
 await store.transaction(async s=>{s.company_research[0].researched_at=new Date().toISOString();s.company_research[0].candidates[0].event_date='2000-01-01';});await assert.rejects(service.draft('P1','Sam','Offer',id),/90 days/);
 }finally{await store.close();}
});
test('old state initializes research without losing verification or proposals',async()=>{
 const {store,source,dir}=await fixture();await store.close();const path=join(dir,'data','state.json');const saved=JSON.parse(await readFile(path,'utf8'));delete saved.company_research;await writeFile(path,JSON.stringify(saved));const reopened=new Store(source,join(dir,'data'));try{await reopened.init();assert.deepEqual(reopened.state.company_research,[]);assert.deepEqual(reopened.state.assessments,saved.assessments);assert.deepEqual(reopened.state.proposals,saved.proposals);}finally{await reopened.close();}
});
const now=Date.parse('2026-11-04T12:00:00Z');
const companyInput={company:'Acme',country:'US',domain:'acme.com'};
const identity={company_website:'https://acme.com',identity_source_url:'https://acme.com',identity_excerpt:'Acme is in US'};
const event={type:'recent_event',summary:'Acme launched Atlas',event_date:'2026-11-01',source_url:'https://acme.com',excerpt:'Acme launched Atlas',date_excerpt:'November 1, 2026'};
const fact={type:'company_fact',summary:'Acme builds software',event_date:null,source_url:'https://acme.com',excerpt:'Acme builds software',date_excerpt:null};
const page={url:'https://acme.com',markdown:'Acme is in US. Acme launched Atlas. November 1, 2026. Acme builds software.'};
function tools(candidates:unknown[],extra={}){return {search:async()=>[page],extract:async()=>({...identity,candidates,...extra})};}
test('date bounds use event dates, reject future, invalid and old dates',()=>{
 assert(recentEvent('2026-11-04',now));assert(recentEvent('2026-08-06',now));for(const date of ['2026-08-05','2026-11-05','2026-02-30',''])assert(!recentEvent(date,now));
});
test('research chooses current events first, falls back to facts, rejects invented excerpts',async()=>{
 const r=await researchCompany(companyInput,tools([fact,event]),now);assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].type,'recent_event');
 const fallback=await researchCompany(companyInput,tools([{...event,event_date:'2020-01-01'},fact]),now);assert.equal(fallback.candidates[0].type,'company_fact');assert(fallback.candidates[0].icebreaker.startsWith('I saw that'));
 for(const invalid of [{...event,excerpt:'invented'}, {...event,event_date:null},{...event,date_excerpt:'yesterday'}, {...event,source_url:'https://fabricated.com'}, {...event,summary:'unrelated claim'}])assert.equal((await researchCompany(companyInput,tools([invalid]),now)).candidates.length,0);
});
test('ambiguous identity, no sources and provider errors remain unresolved or fail',async()=>{
 assert.equal((await researchCompany(companyInput,tools([event],{company_website:'https://other.com'}),now)).candidates.length,0);
 assert.equal((await researchCompany(companyInput,{search:async()=>[],extract:async()=>{throw Error();}},now)).candidates.length,0);
 await assert.rejects(researchCompany(companyInput,{search:async()=>{throw Error('outage');},extract:async()=>({})},now),/outage/);
});
const evidence=()=>({company_website:'https://acme.com',identity_source_url:'https://acme.com/about',identity_excerpt:'Acme is a US software company',
 candidates:[{type:'company_fact' as const,summary:'Acme builds scheduling software for clinics',source_url:'https://acme.com/about',excerpt:'Today, Acme builds scheduling software for clinics.'}]});
const pages:Record<string,string>={'https://acme.com/about':'About us. Acme is a US software company. Today, Acme builds scheduling software for clinics. Contact.'};
test('without evidence the provider asks Claude to research and never touches the network',async()=>{
 let fetches=0;const p=new Providers(async()=>{fetches++;throw Error('no network');});
 await assert.rejects(p.researchCompany(lead),(e:unknown)=>e instanceof ResearchNeededError&&e.target.known_domain==='acme.com'&&/acme\.com/.test(e.target.identity_requirement));
 assert.equal(fetches,0);
});
test('Claude-supplied evidence is kept only when quotes appear on the downloaded pages',async()=>{
 const fetched:string[]=[];const p=new Providers(async url=>{fetched.push(url);if(!pages[url])throw Error('HTTP 404');return {url,markdown:pages[url]};});
 const ok=await p.researchCompany(lead,undefined,evidence());assert.deepEqual(fetched,['https://acme.com/about']);assert.equal(ok.candidates.length,1);assert.equal(ok.candidates[0].icebreaker,'I saw that Acme builds scheduling software for clinics.');assert.deepEqual(ok.rejected,[]);
 // Typography differences are normalized; wording differences are not.
 const curly={...evidence(),identity_excerpt:'Acme  is a US software company'};assert.equal((await p.researchCompany(lead,undefined,curly)).candidates.length,1);
 const invented=evidence();invented.candidates[0].excerpt='Acme builds the best scheduling software for clinics.';invented.candidates[0].summary='Acme builds the best scheduling software';
 const bad=await p.researchCompany(lead,undefined,invented);assert.equal(bad.candidates.length,0);assert(bad.rejected!.some(r=>/not found verbatim/.test(r)));
 const missing={...evidence(),candidates:[{...evidence().candidates[0],source_url:'https://acme.com/missing'}]};const gone=await p.researchCompany(lead,undefined,missing);assert.equal(gone.candidates.length,0);assert(gone.rejected!.some(r=>/Could not read https:\/\/acme\.com\/missing/.test(r)));
 const wrongSite={...evidence(),company_website:'https://acme-other.com'};const ambiguous=await p.researchCompany(lead,undefined,wrongSite);assert.equal(ambiguous.identity_excerpt,null);assert(ambiguous.rejected!.some(r=>/must both be on acme\.com/.test(r)));
});
test('evidence schema bounds sources and requires http(s) URLs',async()=>{
 assert(!evidenceSchema.safeParse({...evidence(),identity_source_url:'file:///etc/passwd'}).success);
 assert(!evidenceSchema.safeParse({...evidence(),candidates:[]}).success);
 const many={...evidence(),candidates:[0,1,2,3,4].map(i=>({...evidence().candidates[0],source_url:`https://acme.com/${i}`})),locations:[0,1,2,3,4,5].map(i=>({country:'United States',presence_type:'office' as const,source_url:`https://acme.com/l${i}`,excerpt:'office'}))};
 await assert.rejects(new Providers(async url=>({url,markdown:''})).researchCompany(lead,undefined,many),/at most 10/);
});
test('contact evidence: conflicts, wrong person and unrequested fields are rejected with reasons',async()=>{
 const named:Lead={...lead,email:'jane@acme.example',title:''};
 const page='Acme leadership. Jane Smith is Head of IT at Acme. Contact jane.smith@acme.com or j.smith@acme.com. Bob Jones is CFO at Acme.';
 const p=new Providers(async url=>({url,markdown:page}));
 const c=(field:any,value:string,excerpt:string)=>({field,value,source_url:'https://acme.com/leaders',excerpt,identity_explanation:'Acme leadership page'});
 const conflict=await p.research(named,['email','title'],{candidates:[c('email','jane.smith@acme.com','Contact jane.smith@acme.com'),c('email','j.smith@acme.com','j.smith@acme.com'),c('title','Head of IT','Jane Smith is Head of IT at Acme.')]});
 assert.deepEqual(conflict.candidates.map(x=>x.field),['title']);assert(conflict.rejected!.some(r=>/conflicting/.test(r)));
 const unrequested=await p.research(named,['email'],{candidates:[c('title','CFO','Bob Jones is CFO at Acme.')]});assert.equal(unrequested.candidates.length,0);assert(unrequested.rejected!.some(r=>/not requested/.test(r)));
 const other=await new Providers(async url=>({url,markdown:'Bob Jones is CFO at Acme. bob@acme.com'})).research(named,['email'],{candidates:[c('email','bob@acme.com','bob@acme.com')]});assert(other.rejected!.some(r=>/identify this person/.test(r)));
 const unnamed=await p.research({...named,first_name:'',last_name:'',email:'info@acme.com'},['first_name'],{candidates:[c('first_name','Jane','Jane Smith')]});assert.equal(unnamed.candidates.length,0);assert.equal(unnamed.unresolved[0].field,'first_name');
});
