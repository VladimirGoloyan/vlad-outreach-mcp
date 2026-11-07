import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCsv, serializeCsv } from '../src/csv.ts';
import { rulesSchema, matches, type Lead, type State } from '../src/model.ts';
import { groups, selected, labels, handoffs } from '../src/selection.ts';
import { companyKey, type CompanyResearch } from '../src/company.ts';
import { researchCompany } from '../src/research/company-research.ts';
import { Store } from '../src/store.ts';
import { Service } from '../src/service.ts';
import { Providers } from '../src/providers.ts';
const rules=rulesSchema.parse(JSON.parse(await readFile('icp.json','utf8')));
const lead:Lead={lead_id:'A',first_name:'Jane',last_name:'Smith',company:'Acme',country:'Germany',email:'jane.smith@acme.com',title:'Customer Support Agent',industry:'Insurance',headcount:''};
const state=(leads:Lead[],records:CompanyResearch[]=[]):State=>({version:1,source:'test',leads,company_research:records,proposals:[],history:[],assessments:{}});
function record(l=lead,extra:Partial<CompanyResearch>={}):CompanyResearch{return {key:companyKey(l),id:crypto.randomUUID(),company_name:l.company,company_website:'https://acme.com',identity_excerpt:'Acme company',identity_source_url:'https://acme.com',researched_at:new Date().toISOString(),candidates:[],unresolved:[],product_fit:[{product:'krispcx',status:'supported',reason:'Contact center',evidence:[{source_url:'https://acme.com',excerpt:'Acme operates a contact center.'}]},{product:'krispapi',status:'supported',reason:'Embedded voice',evidence:[{source_url:'https://acme.com',excerpt:'Acme game includes voice chat.'}]}],locations:[{country:'USA',presence_type:'office',source_url:'https://acme.com',excerpt:'Acme has an office in the USA.'}],...extra};}
test('individuals qualify independent of size/industry; acronym matching does not admit unrelated coordinators',()=>{
 for(const headcount of ['', '1','100000'])assert(matches({...lead,headcount},rules));
 assert(!matches({...lead,title:'Project Coordinator'},rules));assert(matches({...lead,title:'COO'},rules));
});
test('ready relevant contributor wins over senior generic address; product teams can choose different contacts',()=>{
 const exec={...lead,lead_id:'B',country:'US',email:'info@acme.com',title:'CEO'};
 const engineer={...lead,lead_id:'C',email:'alex@acme.com',first_name:'Alex',title:'VP of Engineering'};
 const s=state([exec,lead,engineer]);const g=groups(s)[0];assert.equal(groups(s).length,1);
 assert.equal(selected(g,'krispwork',rules)!.selected_lead_id,'A');assert.equal(selected(g,'krispcx',rules)!.selected_lead_id,'A');assert.equal(selected(g,'krispapi',rules)!.selected_lead_id,'C');assert.equal(selected(g,'krispwork',rules)!.alternative_lead_ids.length,2);
 const tied=groups(state([lead,{...lead,lead_id:'D'}]))[0];assert.equal(selected(tied,'krispwork',rules)!.selected_lead_id,'A');
});
test('conflicting domains and namesakes remain separate; resolved canonical domain groups known aliases',()=>{
 assert.equal(groups(state([lead,{...lead,lead_id:'B',email:'jane@unrelated.com'}])).length,2);
 assert.equal(groups(state([{...lead,email:'a@gmail.com'},{...lead,lead_id:'B',company:'Other',email:'b@gmail.com'}])).length,2);
 const alias={...lead,lead_id:'B',company:'Acme Incorporated',country:'India'};
 assert.equal(groups(state([lead,alias],[record(lead),record(alias)])).length,1);
});
test('regional priority needs current researched presence, not CSV country; supported CX/API flags expire and deactivate',()=>{
 assert.equal(labels(groups(state([{...lead,country:'US'}]))[0],rules).top_lead,false);
 const s=state([lead],[record()]);assert(labels(groups(s)[0],rules).top_lead);assert.equal(handoffs(s,rules).length,2);
 const stale=state([lead],[record(lead,{researched_at:'2000-01-01'})]);assert(!labels(groups(stale)[0],rules).top_lead);assert.equal(handoffs(stale,rules)[0].status,'stale');
 s.company_research.push(record(lead,{product_fit:[],locations:[]}));assert.equal(handoffs(s,rules)[0].status,'inactive');
 assert.equal(labels(groups(state([lead],[record()]))[0],{...rules,priority_countries:[]}).top_lead,false);
});
test('research accepts voice-in-game evidence but rejects text-only, invented and customer-only location claims',async()=>{
 const page={url:'https://acme.com',markdown:'Acme Germany. Acme game has in-game voice chat. Acme operates a contact center. Acme has employees in the USA. Acme serves customers in India.'};
 const raw={company_website:page.url,identity_source_url:page.url,identity_excerpt:'Acme Germany',candidates:[],product_fit:[{product:'krispapi',status:'supported',reason:'Voice feature',evidence:[{source_url:page.url,excerpt:'Acme game has in-game voice chat.'}]}],locations:[{country:'US',presence_type:'employees',source_url:page.url,excerpt:'Acme has employees in the USA.'},{country:'India',presence_type:'office',source_url:page.url,excerpt:'Acme serves customers in India.'}]};
 const tools={search:async()=>[page],extract:async()=>raw};const result=await researchCompany({company:'Acme',country:'Germany',domain:'acme.com'},tools);
 assert.equal(result.product_fit?.find(f=>f.product==='krispapi')?.status,'supported');assert.equal(result.locations?.length,1);assert.equal(result.locations?.[0].country,'United States');
 raw.product_fit[0].evidence[0].excerpt='Acme only has text chat.';assert.equal((await researchCompany({company:'Acme',country:'Germany',domain:'acme.com'},tools)).product_fit?.find(f=>f.product==='krispapi')?.status,'insufficient_evidence');
});
test('selection is before limit, alternatives retained and exports refresh after corrections',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'selection-'));const source=join(dir,'leads.csv'),config=join(dir,'icp.json');const other={...lead,lead_id:'B',email:'info@acme.com',title:'CEO'};await writeFile(source,serializeCsv([other,lead,{...lead,company:'Other',lead_id:'C',email:'c@other.com'}]));await writeFile(config,JSON.stringify(rules));const store=new Store(source,join(dir,'data'));await store.init();const service=new Service(store,new Providers(),config);
 try{const first=await service.find(1);assert.equal(first.unique_companies,2);assert.equal(first.leads[0].lead_id,'A');assert.equal(store.state.leads.length,3);
 await store.transaction(async s=>{s.leads[0].email='boss@acme.com';s.company_research.push(record(s.leads[1]));});
 assert.equal((await service.find(1)).leads[0].lead_id,'B');const list=await service.listHandoffs();assert(list.handoffs.some(h=>h.product_line==='krispcx'));assert((await service.downloadFiles(['lead-priorities.csv']))[0].content.includes('"B"'));assert.equal(parseCsv(await readFile(source,'utf8'))[0].email,'info@acme.com');
 }finally{await store.close();}
});
test('startup configuration failure releases dataset lock for retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'retry-'));const source=join(dir,'leads.csv'),config=join(dir,'icp.json');await writeFile(source,serializeCsv([lead]));await writeFile(config,'{}');const data=join(dir,'data');const store=new Store(source,data);await store.init();await assert.rejects(new Service(store,new Providers(),config).initialize());const retry=new Store(source,data);await retry.init();await retry.close();
});
test('without research, CX/API potential comes from industry or explicit use-case titles, not general titles',async()=>{
 const {groups,labels}=await import('../src/selection.ts');
 const rules=rulesSchema.parse(JSON.parse(await readFile('icp.json','utf8')));
 const mk=(id:string,company:string,industry:string,title:string)=>({...lead,lead_id:id,company,industry,title,email:`${id}@${company.toLowerCase()}.com`});
 const state={version:1 as const,source:'x',leads:[mk('B','Echo','BPO / Outsourcing','Head of Operations'),mk('C','Northwind','Software','COO'),mk('E','Harbor','Software','VP of Engineering'),mk('G','Fable','Gaming','Producer'),mk('V','Voicely','Software','Head of Voice Products'),mk('K','Callco','Retail','Contact Center Manager')],proposals:[],assessments:{},history:[],company_research:[]};
 const fit=(company:string,product:string)=>labels(groups(state).find(g=>g.members[0].lead.company===company)!,rules).product_fit.find(f=>f.product===product)!;
 assert.equal(fit('Echo','krispcx').status,'potential');assert.match(fit('Echo','krispcx').reason,/BPO/);
 assert.equal(fit('Northwind','krispcx').status,'insufficient_evidence');
 assert.equal(fit('Harbor','krispapi').status,'insufficient_evidence');
 assert.equal(fit('Fable','krispapi').status,'potential');assert.equal(fit('Voicely','krispapi').status,'potential');
 assert.equal(fit('Callco','krispcx').status,'potential');assert.match(fit('Callco','krispcx').reason,/Contact Center Manager/);
});
