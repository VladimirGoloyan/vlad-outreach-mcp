import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.ts';
import { DatasetSessions } from './sessions.ts';
import { resolveDataset, workingFolder, type DatasetSource } from './desktop-config.ts';
import type { Service } from './service.ts';

// No dataset is opened at startup. Each tool call names its CSV, opens that dataset, and closes
// it when the call finishes, so the files are free for other tools and processes between calls.
const defaultRules=fileURLToPath(new URL('../icp.json',import.meta.url));
const sessions=new DatasetSessions();
async function withDataset<T extends object>(source:DatasetSource,work:(service:Service)=>Promise<T>){
  const dataset=await resolveDataset(source,defaultRules,await workingFolder());
  const result=await sessions.run(dataset,work);
  return {dataset_id:dataset.id,...result};
}
const server=createServer({
  prepareLeads:(options,source)=>withDataset(source,service=>service.prepareLeads(options)),
  prepareDraft:(id,sender,offer,icebreaker,website,evidence,personalization,salutation,source)=>withDataset(source,service=>service.prepareDraft(id,sender,offer,icebreaker,website,evidence,personalization,salutation)),
});
const handle=serveStdio(()=>server,{onerror:e=>console.error(`Vlad Outreach MCP protocol: ${e.message}`)});
console.error(`Vlad Outreach MCP: protocol ready; Node ${process.versions.node}, ${process.platform}/${process.arch}. Each tool call opens and closes its own dataset.`);
let closing=false;
async function close(){if(closing)return;closing=true;await handle.close().catch(()=>{});await sessions.close();}
process.once('SIGINT',()=>{void close().finally(()=>process.exit(0));});
process.once('SIGTERM',()=>{void close().finally(()=>process.exit(0));});
process.stdin.once('end',()=>{void close().finally(()=>process.exit(0));});
