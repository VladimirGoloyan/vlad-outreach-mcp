import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCsv, serializeCsv } from './csv.ts';
import type { State } from './model.ts';

export async function atomicWrite(path:string,content:string) {
  await mkdir(dirname(path),{recursive:true});const tmp=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(tmp,content,'utf8');await rename(tmp,path);}finally{await unlink(tmp).catch(()=>{});}
}
export class Store {
  source:string; enriched:string; statePath:string; state!:State;
  private queue:Promise<unknown>=Promise.resolve();
  private lock?:Awaited<ReturnType<typeof open>>;
  private lockWaitMs:number;
  constructor(source:string,data:string,enriched?:string,options:{lockWaitMs?:number}={}) {
    this.source=resolve(source);this.enriched=enriched?resolve(enriched):this.source.replace(/\.csv$/i,'')+'.enriched.csv';this.statePath=resolve(data,'state.json');
    this.lockWaitMs=options.lockWaitMs??0;
    if(this.enriched===this.source)throw new Error('Enriched output must not overwrite the source CSV');
  }
  /** A lock whose recorded process no longer exists was left by a crash and can be reclaimed. */
  private async staleLock(path:string){
    const pid=Number((await readFile(path,'utf8').catch(()=>'')).trim());
    if(!Number.isInteger(pid)||pid<=0||pid===process.pid)return false;
    try{process.kill(pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
  }
  private async acquireLock(){
    const path=this.statePath+'.lock',until=Date.now()+this.lockWaitMs;
    for(;;){
      try{this.lock=await open(path,'wx');await this.lock.writeFile(String(process.pid));return;}
      catch(e){
        if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
        if(await this.staleLock(path)){await unlink(path).catch(()=>{});continue;}
        if(Date.now()>=until)throw new Error('Data directory is in use by another Vlad Outreach MCP process; try again when it has finished. If no process is running, remove state.json.lock');
        await new Promise(r=>setTimeout(r,100));
      }
    }
  }
  async init() {
    await mkdir(dirname(this.statePath),{recursive:true});
    await this.acquireLock();
    try {
      try {this.state=JSON.parse(await readFile(this.statePath,'utf8'));if(this.state.version!==1||this.state.source!==this.source)throw new Error('State version or CSV source mismatch');}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;let csv:string;try{csv=await readFile(this.enriched,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;csv=await readFile(this.source,'utf8');}this.state={version:1,source:this.source,leads:parseCsv(csv),proposals:[],assessments:{},history:[],company_research:[]};}
      this.state.company_research ??= [];
      // State is authoritative; regenerate export after a crash between the two writes.
      await this.save(this.state);
    }catch(e){await this.close();throw e;}
  }
  async save(next:State) {
    await atomicWrite(this.statePath,JSON.stringify(next,null,2));this.state=next;
    await atomicWrite(this.enriched,serializeCsv(next.leads));
  }
  transaction<T>(fn:(state:State)=>Promise<T>):Promise<T> {
    const work=this.queue.then(async()=>{const copy=structuredClone(this.state);const result=await fn(copy);await this.save(copy);return result;});
    this.queue=work.catch(()=>{});return work;
  }
  async close(){await this.queue;await this.lock?.close();if(this.lock){await unlink(this.statePath+'.lock');this.lock=undefined;}}
}
