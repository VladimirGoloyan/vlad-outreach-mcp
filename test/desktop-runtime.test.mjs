import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

async function extract(destination){
 const archive=await readFile('release/vlad-outreach-mcp.mcpb');let pos=0;const names=[];
 while(archive.readUInt32LE(pos)===0x04034b50){const size=archive.readUInt32LE(pos+18),length=archive.readUInt16LE(pos+26),extra=archive.readUInt16LE(pos+28);assert.equal(archive.readUInt16LE(pos+8),0);const name=archive.subarray(pos+30,pos+30+length).toString();assert(!name.includes('..'));names.push(name);const start=pos+30+length+extra;const path=join(destination,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,archive.subarray(start,start+size));pos=start+size;}
 assert.deepEqual(names.sort(),['README.md','THIRD_PARTY_NOTICES.txt','icp.json','manifest.json','server/index.mjs'].sort());
 return JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));
}
function cleanEnv(extra={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>typeof value==='string'&&!['FIRECRAWL_API_KEY','OPENAI_API_KEY'].includes(key)));
 delete env.OUTREACH_LEADS_CSV;delete env.OUTREACH_WORKING_FOLDER;return {...env,...extra};
}
async function connect(root,work,extraEnv){
 const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
 // An unset optional setting is passed through unexpanded, as an unconfigured install would.
 const args=manifest.server.mcp_config.args.map(value=>value.replace('${__dirname}',root).replace('${user_config.working_folder}',work??'${user_config.working_folder}'));
 const transport=new StdioClientTransport({command:process.execPath,args,cwd:tmpdir(),env:cleanEnv(extraEnv),stderr:'pipe'});
 const client=new Client({name:'desktop-bundle-test',version:'1.0.0'});await client.connect(transport);return client;
}
const call=async(client,name,args)=>{const r=await client.callTool({name,arguments:args});return {error:r.isError?r.content[0].text:undefined,body:r.isError?undefined:JSON.parse(r.content[0].text)};};
const unlocked=async dataset=>{await assert.rejects(access(join(dataset,'.state','state.json.lock')),/ENOENT/);};
test('installed bundle takes the CSV per call, keeps datasets separate and releases each dataset after the call',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'desktop bundle ')),install=join(temp,'install'),work=join(temp,'workspace'),source=join(temp,'source.csv');await mkdir(work);
 const original=await readFile('leads/leads.csv');await writeFile(source,original);const manifest=await extract(install);
 assert.deepEqual(Object.keys(manifest.user_config),['working_folder']);assert.equal(manifest.user_config.working_folder.required,false);assert(!JSON.stringify(manifest).includes('OPENAI'));
 let client=await connect(install,work);let id;
 try{
  const tools=(await client.listTools()).tools;assert.equal(tools.length,2);const guide=client.getInstructions();assert.match(guide,/not web search/);assert.match(guide,/leads_csv_content/);assert.match(guide,/top/);assert.match(tools.find(x=>x.name==='find_leads').description,/^Use for any request/);assert.match(tools.find(x=>x.name==='find_leads').description,/attached in chat/);for(const t of tools)for(const key of ['leads_csv','leads_csv_content','dataset_id'])assert(t.inputSchema.properties[key],`${t.name}.${key}`);
  const missing=await call(client,'find_leads',{});assert.match(missing.error,/leads_csv/);
  const first=await call(client,'find_leads',{leads_csv:source});assert(!first.error,first.error);id=first.body.dataset_id;assert(id);assert(first.body.leads.every(l=>l.verification.method==='regex'));
  assert(first.body.data_quality);assert.match((await call(client,'draft_email',{dataset_id:id,lead_id:'L035',icebreaker_id:'nonexistent'})).error,/Unknown icebreaker/);
  // Private helpers must not be callable even when their names are known.
  for(const name of ['audit_leads','verify_email','enrich_lead','apply_enrichment','research_company','list_handoffs']){let refused=false;try{const response=await client.callTool({name,arguments:{}});refused=Boolean(response.isError);}catch{refused=true;}assert(refused,`Private helper ${name} must not be callable`);}
  await unlocked(join(work,id));
  const research=await call(client,'find_leads',{dataset_id:id,lead_ids:['L032'],research:true});assert(!research.error,research.error);assert.equal(research.body.dataset_id,id);assert.equal(research.body.research_requests.length,1);
  const draft=await call(client,'draft_email',{dataset_id:id,lead_id:'L032',sender_name:'Sam',offer:'We help teams.'});assert(!draft.error,draft.error);assert.equal(draft.body.status,'research_needed');assert.match(draft.body.fallback,/lead_data/);
  const fallback=await call(client,'draft_email',{dataset_id:id,lead_id:'L032',sender_name:'Sam',offer:'We help teams.',personalization:'lead_data'});assert(!fallback.error,fallback.error);assert.equal(fallback.body.status,'drafted');assert.equal(fallback.body.ready_to_send,false);assert.equal(fallback.body.personalization.basis,'lead_data');
  const updates=[];const watched=await client.callTool({name:'draft_email',arguments:{dataset_id:id,lead_id:'L032',personalization:'lead_data'}},{onprogress:p=>updates.push(p)});assert(!watched.isError);assert.equal(updates.at(-1).progress,1);assert.equal(updates.at(-1).total,1);assert.match(updates[0].message,/Drafting the email for lead L032/);assert.equal(updates.at(-1).message,'Email drafted for Emma Khan at Northwind Analytics (role angle). 1 draft so far');assert.equal(JSON.parse(watched.content[0].text).activity,updates.at(-1).message);const listed=await client.listTools();assert.equal(listed.tools.find(t=>t.name==='find_leads').title,'Find and rank leads');assert.match(client.getInstructions(),/Keep the user informed/);
  const dl=await client.callTool({name:'find_leads',arguments:{dataset_id:id,download_files:['drafts.md','other-product-leads.csv']}});assert(!dl.isError,dl.content[0].text);const att=dl.content.filter(c=>c.type==='resource');assert.deepEqual(att.map(c=>c.resource.uri),['outreach://downloads/drafts.md','outreach://downloads/other-product-leads.csv']);assert.equal(att[0].resource.mimeType,'text/markdown');assert(att[0].resource.text.startsWith('# Email drafts (1)'));
  const top=await call(client,'find_leads',{dataset_id:id,limit:10});assert.equal(top.body.leads.length,10);assert.deepEqual(top.body.leads.map(l=>l.rank),[1,2,3,4,5,6,7,8,9,10]);
  await unlocked(join(work,id));
  // A second, independent process can use the same dataset while this session stays connected.
  const other=await connect(install,work);try{const r=await call(other,'find_leads',{dataset_id:id});assert(!r.error,r.error);}finally{await other.close();}
  const again=await call(client,'find_leads',{dataset_id:id});assert(!again.error,again.error);
  // Attached content becomes its own dataset; the same content maps to the same dataset.
  const uploaded=await call(client,'find_leads',{leads_csv_content:original.toString('utf8'),leads_csv_name:'Attached leads.csv'});assert(!uploaded.error,uploaded.error);assert.match(uploaded.body.dataset_id,/^Attached_leads-u[0-9a-f]{12}$/);assert.notEqual(uploaded.body.dataset_id,id);
  assert.equal((await call(client,'find_leads',{leads_csv_content:original.toString('utf8')})).body.total_matches,uploaded.body.total_matches);
  const both=await call(client,'find_leads',{leads_csv:source,dataset_id:id});assert.match(both.error,/exactly one/);
  assert.match((await call(client,'find_leads',{dataset_id:'../escape'})).error,/Invalid dataset_id/);
 }finally{await client.close();}
 assert.deepEqual(await readFile(source),original);const dataset=join(work,id);assert((await readFile(join(dataset,'leads.enriched.csv'),'utf8')).includes('L001'));await unlocked(dataset);
 const rules=JSON.parse(await readFile(join(dataset,'icp.json'),'utf8'));rules.industries=[];rules.title_keywords=[];rules.min_headcount=null;rules.max_headcount=null;await writeFile(join(dataset,'icp.json'),JSON.stringify(rules));
 await extract(install);client=await connect(install,work);try{const all=await call(client,'find_leads',{dataset_id:id});assert.equal(all.body.total_matches,25);
  const otherCsv=join(temp,'another.csv');await writeFile(otherCsv,original);const second=await call(client,'find_leads',{leads_csv:otherCsv});assert.notEqual(second.body.dataset_id,id);}finally{await client.close();}
 assert.equal((await readdir(work)).length,4);
 assert.deepEqual((await readdir(install)).sort(),['README.md','THIRD_PARTY_NOTICES.txt','icp.json','manifest.json','server'].sort());
});
test('bundle discovers tools before any file IO and returns a clear error for unavailable files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'desktop settings '));await extract(root);const work=join(root,'work');await mkdir(work);
 const start=Date.now();const client=await connect(root,work);
 try{assert.equal((await client.listTools()).tools.length,2);assert(Date.now()-start<5000);const result=await call(client,'find_leads',{leads_csv:join(root,'does-not-exist.csv')});assert.match(result.error,/ENOENT|no such file/i);
  assert.match((await call(client,'find_leads',{leads_csv:'relative/leads.csv'})).error,/absolute path/);}finally{await client.close();}
});
test('without a Working folder setting, datasets go to "Outreach MCP" in the home folder',async()=>{
 const root=await mkdtemp(join(tmpdir(),'desktop home '));await extract(root);const home=join(root,'home');await mkdir(home);
 const client=await connect(root,undefined,{HOME:home,USERPROFILE:home});
 try{const r=await call(client,'find_leads',{leads_csv:resolve('leads/leads.csv')});assert(!r.error,r.error);assert.deepEqual(await readdir(join(home,'Outreach MCP')),[r.body.dataset_id]);}finally{await client.close();}
});
for(const protocolVersion of ['2024-11-05','2025-03-26','2025-11-25'])test(`raw Claude-era handshake ${protocolVersion} works without dataset access`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'legacy probe '));await extract(root);
 const child=spawn(process.execPath,[join(root,'server/index.mjs'),'--working-folder',root],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout});
 const request=async message=>{const next=once(lines,'line',{signal:AbortSignal.timeout(5000)});child.stdin.write(JSON.stringify(message)+'\n');return JSON.parse((await next)[0]);};
 try{
  const init=await request({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'claude-probe',version:'1'}}});assert.equal(init.result.protocolVersion,protocolVersion);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await request({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});assert.deepEqual(tools.result.tools.map(t=>t.name).sort(),['draft_email','find_leads']);
 }finally{child.stdin.end();await once(child,'exit',{signal:AbortSignal.timeout(5000)});lines.close();}
});
