// Each tool call opens its dataset, does its work and closes it again, so the dataset lock is
// held only while a call runs. Other processes (another Claude window, a spreadsheet
// tool reading leads.enriched.csv) can use the same files between calls.
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { Service } from './service.ts';
import { Providers } from './providers.ts';

export type DatasetPaths = {source:string;data:string;enriched?:string;config:string};

function deadline<T>(work:Promise<T>,ms:number,message:string):Promise<T>{
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(message)),ms);
    work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}

export class DatasetSessions {
  private queues=new Map<string,Promise<unknown>>();
  private closing=false;
  private providers:Providers;
  private lockWaitMs:number;
  private openTimeoutMs:number;
  constructor(providers=new Providers(),options:{lockWaitMs?:number;openTimeoutMs?:number}={}){
    this.providers=providers;this.lockWaitMs=options.lockWaitMs??10_000;this.openTimeoutMs=options.openTimeoutMs??20_000;
  }
  /** Run one unit of work against a freshly opened dataset; the dataset is always closed afterwards. */
  run<T>(paths:DatasetPaths,work:(service:Service)=>Promise<T>):Promise<T>{
    if(this.closing)return Promise.reject(new Error('Server is shutting down'));
    const key=resolve(paths.data);
    // Calls on the same dataset run one after another inside this process.
    const previous=this.queues.get(key)??Promise.resolve();
    const run=previous.catch(()=>{}).then(async()=>{
      const store=new Store(paths.source,paths.data,paths.enriched,{lockWaitMs:this.lockWaitMs});
      const opening=(async()=>{await store.init();const service=new Service(store,this.providers,paths.config);await service.initialize();return service;})();
      let service:Service;
      try{service=await deadline(opening,this.openTimeoutMs,`Opening the dataset took longer than ${Math.round(this.openTimeoutMs/1000)} seconds. Check that the CSV is available locally (download cloud-only files) and the Working folder is writable.`);}
      catch(e){opening.then(()=>store.close(),()=>{}).catch(()=>{});throw e;}
      try{return await work(service);}
      finally{await store.close();}
    });
    const settled=run.catch(()=>{});
    this.queues.set(key,settled);
    void settled.then(()=>{if(this.queues.get(key)===settled)this.queues.delete(key);});
    return run;
  }
  /** Stop accepting calls and wait briefly for running ones to close their datasets. */
  async close(timeoutMs=3000){
    this.closing=true;
    await deadline(Promise.allSettled([...this.queues.values()]),timeoutMs,'Shutdown deadline').catch(()=>{});
  }
}
