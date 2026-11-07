import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.ts';
import { Service } from '../src/service.ts';
import { Providers, verificationKey } from '../src/providers.ts';
import { parseCsv, serializeCsv } from '../src/csv.ts';
import { emailIssues, matches, rulesSchema, type Lead } from '../src/model.ts';
import { research } from '../src/research/research.ts';

const sample=await readFile('leads/leads.csv','utf8');
const rules=JSON.parse(await readFile('icp.json','utf8'));
const real:Lead={lead_id:'T1',first_name:'Jane',last_name:'Smith',title:'Head of IT',company:'Acme',industry:'Software',headcount:'75',country:'US',email:'jane.smith@acme.com'};
function provider(){return new Providers(async()=>{throw Error('Unexpected network call');});}
async function fixture(csv=sample,p=new Providers()){
  const dir=await mkdtemp(join(tmpdir(),'outreach-'));const source=join(dir,'leads.csv'),config=join(dir,'icp.json');
  await writeFile(source,csv);await writeFile(config,JSON.stringify(rules));const store=new Store(source,join(dir,'data'));await store.init();return {store,service:new Service(store,p,config),config,source,dir};
}
test('CSV round trip supports BOM, quotes, commas, CRLF and embedded newlines',()=>{const leads=[{...real,company:'Acme, "Labs"\nInc'}];assert.deepEqual(parseCsv('\uFEFF'+serializeCsv(leads)),leads);assert.throws(()=>parseCsv(serializeCsv([real,real])),/duplicate/);assert.throws(()=>parseCsv('x,y\n1,2'),/headers/);assert.throws(()=>parseCsv(serializeCsv([real])+'"'),/unclosed/);});
test('sample audit and deduplicated ICP matches, rules reload without restart',async()=>{const {store,service,config}=await fixture();try{assert.equal(service.audit().total,50);const issues=service.audit().leads;assert.equal(issues.filter(l=>l.missing_fields.length).length,3);assert.equal(issues.filter(l=>l.email_issues.includes('placeholder_email')).length,49);assert(issues.find(l=>l.lead_id==='L048')?.email_issues.includes('invalid_email'));const found=await service.find(100,'csv');assert.equal(found.matching_contacts,34);assert.equal(found.unique_companies,23);assert.equal(new Set(found.leads.map(l=>l.company_id)).size,23);assert.equal(found.leads[0].lead_id,'L001');await writeFile(config,JSON.stringify({...rules,industries:[],title_keywords:[],min_headcount:null,max_headcount:null}));assert.equal((await service.find()).total_matches,25);await writeFile(config,'{}');await assert.rejects(service.find());}finally{await store.close();}});
test('headcount remains optional and custom bounds still work',()=>{const rules={industries:[],title_keywords:[],countries:[],priority_countries:[],min_headcount:20,max_headcount:500};assert(matches({...real,headcount:'20'},rules));assert(matches({...real,headcount:'500',industry:' software '},rules));assert(!matches({...real,headcount:''},rules));assert(!matches({...real,headcount:'501'},rules));assert(!rulesSchema.safeParse({...rules,min_headcount:501}).success);});
test('placeholder and generic addresses never make provider requests',async()=>{let calls=0;const p=new Providers(async()=>{calls++;throw Error();});for(const email of ['info@acme.com','a@company.example','bad','sales+team@acme.com'])assert(!(await p.verify({...real,email})).eligible);assert.equal(calls,0);assert(emailIssues('a@sub.example.com').includes('placeholder_email'));});
test('local checks distinguish format, generic and advisory name patterns without network',async()=>{
 const p=provider();const a=await p.verify(real);assert(a.eligible);assert.equal(a.deliverability,'not_checked');assert.equal(a.mailbox_type,'unknown');assert.equal(a.name_pattern,'matches');
 for(const email of ['jane.smith@acme.com','janesmith@acme.com','jsmith+tag@acme.com'])assert.equal((await p.verify({...real,email})).name_pattern,'matches');
 const mismatch=await p.verify({...real,email:'someone@acme.com'});assert(mismatch.eligible);assert.equal(mismatch.name_pattern,'does_not_match');
 assert.equal((await p.verify({...real,last_name:''})).name_pattern,'insufficient_name_data');
 for(const email of ['a..b@acme.com','a@-acme.com','a@acme-.com','a@acme..com','x'.repeat(65)+'@acme.com','info+tag@acme.com'])assert(!(await p.verify({...real,email})).eligible);
});
test('draft gating, warnings, local recomputation and persistence',async()=>{const base=provider();const {store,service,source,dir}=await fixture(serializeCsv([real]),base);try{await store.transaction(async s=>{s.assessments['legacy']={eligible:true,identity:'supported_match',deliverability:'valid'} as any;});base.researchCompany=async()=>({company_name:'Acme',company_website:'https://acme.com',identity_excerpt:'Acme US',identity_source_url:'https://acme.com',candidates:[{type:'company_fact',summary:'Acme builds software',event_date:null,date_excerpt:null,source_url:'https://acme.com',excerpt:'Acme builds software',icebreaker:'I saw that Acme builds software.'}],unresolved:[]});const research=await service.researchCompany('T1');const d=await service.draft('T1','Sam','We help teams improve onboarding.',research.candidates[0].id);assert.equal(d.warnings.length,2);assert(/Salutation unknown/.test(d.warnings[0]));assert(d.body.split(/\s+/).length<170);await service.verify('T1');await service.verify('T1',true);await store.transaction(async s=>{s.leads[0].last_name='Jones';});assert.equal(service.assessment(store.state.leads[0]).name_pattern,'does_not_match');await store.close();const restarted=new Store(source,join(dir,'data'));await restarted.init();assert.equal(restarted.state.leads[0].last_name,'Jones');await restarted.close();}finally{await store.close();}});
test('proposals need review, apply atomically, survive restart and reject stale/repeated updates',async()=>{
 const p=provider();p.research=async()=>({candidates:[{field:'headcount',value:'100',source_url:'https://acme.com/team',excerpt:'Acme has 100 employees',identity_explanation:'Same company'}],unresolved:[]});
 const {store,service,source}=await fixture(serializeCsv([real]),p);
 try{const first=await service.enrich('T1',['headcount']);const second=await service.enrich('T1',['headcount']);assert.equal(store.state.leads[0].headcount,'75');await service.apply([first.proposals[0].id]);assert.equal(store.state.leads[0].headcount,'100');assert.equal((await service.apply([first.proposals[0].id])).applied.length,0);await assert.rejects(service.apply([second.proposals[0].id]),/Stale/);assert.equal(parseCsv(await readFile(source,'utf8'))[0].headcount,'75');assert.equal(parseCsv(await readFile(store.enriched,'utf8'))[0].headcount,'100');assert.equal(store.state.history.length,1);}finally{await store.close();}
});
test('invalid replacement email cannot be applied',async()=>{const p=provider();p.research=async()=>({candidates:[{field:'email',value:'info@acme.com',source_url:'https://acme.com',excerpt:'info@acme.com',identity_explanation:'Public contact'}],unresolved:[]});const {store,service}=await fixture(serializeCsv([real]),p);try{const r=await service.enrich('T1',['email']);await assert.rejects(service.apply([r.proposals[0].id]),/rejected/);assert.equal(store.state.leads[0].email,real.email);}finally{await store.close();}});
test('research does not invent a person for a generic email',async()=>{const r=await research({lead:{company:'Acme',email:'info@acme.com'},fields:['first_name','last_name','email']},{search:async()=>{throw Error('Should not search');},extract:async()=>({})});assert.equal(r.candidates.length,0);assert.equal(r.unresolved.length,3);});
test('research requires exact source quotes and rejects conflicting values',async()=>{const c={field:'headcount',value:'100',source_url:'https://acme.com',excerpt:'Acme has 100 employees',identity_explanation:'Acme company page'};const tools={search:async()=>[{url:c.source_url,markdown:'Acme has 100 employees. Acme has 200 employees.'}],extract:async()=>({candidates:[c]})};assert.equal((await research({lead:real,fields:['headcount']},tools)).candidates.length,1);tools.extract=async()=>({candidates:[{...c,excerpt:'invented'}]});assert.equal((await research({lead:real,fields:['headcount']},tools)).candidates.length,0);tools.extract=async()=>({candidates:[c,{...c,value:'200',excerpt:'Acme has 200 employees'}]});assert.equal((await research({lead:real,fields:['headcount']},tools)).candidates.length,0);});
test('data directory lock prevents concurrent writers',async()=>{const {store,source,dir}=await fixture();try{await assert.rejects(new Store(source,join(dir,'data')).init(),/in use/);}finally{await store.close();}});

test('legacy assessments cannot override local checks or make a generic address eligible',async()=>{
 const {store,service}=await fixture(serializeCsv([real]));try{
 await store.transaction(async s=>{s.assessments[verificationKey(real)]={key:verificationKey(real),checked_at:new Date().toISOString(),eligible:false,deliverability:'invalid',identity:'conflict'} as any;});
 assert(service.assessment(real).eligible);assert.equal((await service.verify(real.lead_id)).method,'regex');
 await store.transaction(async s=>{s.leads[0].email='info@acme.com';const key=verificationKey(s.leads[0]);s.assessments[key]={key,checked_at:new Date().toISOString(),eligible:true,deliverability:'valid',identity:'supported_match'} as any;});
 assert(!(await service.verify(real.lead_id)).eligible);
 }finally{await store.close();}
});
test('a waiting store gets the lock once the holder closes, and crashed holders are reclaimed',async()=>{
 const {store,source,dir}=await fixture();
 const waiting=new Store(source,join(dir,'data'),undefined,{lockWaitMs:5000});const started=waiting.init();
 await new Promise(r=>setTimeout(r,250));await store.close();await started;await waiting.close();
 // A lock file naming a process that no longer exists is left over from a crash.
 const {spawnSync}=await import('node:child_process');const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout;
 await writeFile(join(dir,'data','state.json.lock'),dead);const reclaimed=new Store(source,join(dir,'data'));await reclaimed.init();await reclaimed.close();
});
