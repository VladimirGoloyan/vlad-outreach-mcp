import { realpath, mkdir, copyFile, constants, stat, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** How a tool call names the leads CSV it works on. Exactly one is used. */
export type DatasetSource = {leads_csv?:string;leads_csv_content?:string;leads_csv_name?:string;dataset_id?:string};
export type Dataset = {id:string;source:string;dataset:string;config:string;data:string;enriched:string};
export const MAX_UPLOAD_BYTES=5_000_000;

const argument=(flag:string)=>{const index=process.argv.indexOf(flag);return index<0?undefined:process.argv[index+1];};
// An unset optional setting may arrive empty or as an unexpanded ${...} placeholder.
const setting=(value:string|undefined)=>value&&value.trim()&&!value.includes('${')?value.trim():undefined;
const expandHome=(value:string)=>value==='~'||value.startsWith('~/')||value.startsWith('~\\')?join(homedir(),value.slice(1)):value;

/** Working folder from the extension setting, or "Outreach MCP" in the user's home folder. */
export async function workingFolder(){
  const chosen=setting(argument('--working-folder'))??setting(process.env.OUTREACH_WORKING_FOLDER);
  const folder=chosen?expandHome(chosen):join(homedir(),'Outreach MCP');
  if(!isAbsolute(folder))throw new Error('The Working folder setting must be an absolute path.');
  await mkdir(folder,{recursive:true});
  const real=await realpath(folder);
  if(!(await stat(real)).isDirectory())throw new Error('The Working folder setting must point to a folder.');
  return real;
}
const slug=(name:string)=>basename(name,extname(name)).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,60)||'leads';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex').slice(0,12);

async function prepare(id:string,work:string,source:string,defaultRules:string,meta:Record<string,string>):Promise<Dataset>{
  const dataset=join(work,id);await mkdir(dataset,{recursive:true});
  const config=join(dataset,'icp.json');
  try{await copyFile(defaultRules,config,constants.COPYFILE_EXCL);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  await writeFile(join(dataset,'dataset.json'),JSON.stringify({...meta,source},null,2));
  return {id,source,dataset,config,data:join(dataset,'.state'),enriched:join(dataset,'leads.enriched.csv')};
}
async function savedSource(dataset:string){
  for(const [file,key] of [['dataset.json','source'],[join('.state','state.json'),'source']] as const){
    try{const value=JSON.parse(await readFile(join(dataset,file),'utf8'))[key];if(typeof value==='string')return value;}catch{}
  }
  return undefined;
}

/** Map a tool call's CSV reference to its dataset folder, creating it on first use. Source files are never modified. */
export async function resolveDataset(input:DatasetSource,defaultRules:string,work:string):Promise<Dataset>{
  const given=[input.leads_csv,input.leads_csv_content,input.dataset_id].filter(v=>v!==undefined).length;
  if(given!==1)throw new Error('Provide exactly one of: leads_csv (absolute path to a local CSV file), leads_csv_content (the CSV text, e.g. from a file attached in chat) or dataset_id (returned by an earlier call). Ask the user which leads file to use if unsure.');
  if(input.dataset_id!==undefined){
    const id=input.dataset_id;
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new Error('Invalid dataset_id');
    const dataset=join(work,id);
    const source=await stat(dataset).then(s=>s.isDirectory()?savedSource(dataset):undefined,()=>undefined);
    if(!source)throw new Error(`Unknown dataset_id "${id}". Provide the leads file again with leads_csv or leads_csv_content.`);
    await stat(source).catch(()=>{throw new Error(`The CSV for dataset "${id}" is no longer at ${source}. Provide it again with leads_csv or leads_csv_content.`);});
    return prepare(id,work,source,defaultRules,JSON.parse(await readFile(join(dataset,'dataset.json'),'utf8').catch(()=>'{"kind":"path"}')));
  }
  if(input.leads_csv!==undefined){
    const path=expandHome(input.leads_csv.trim());
    if(!isAbsolute(path))throw new Error('leads_csv must be an absolute path to a CSV file on this computer.');
    const source=await realpath(path);
    if(!(await stat(source)).isFile())throw new Error('leads_csv must point to a file.');
    // Same identity scheme as earlier versions, so existing saved datasets are reused.
    const id=`${slug(source)}-${hash(process.platform==='win32'?source.toLowerCase():source)}`;
    return prepare(id,work,source,defaultRules,{kind:'path'});
  }
  const content=input.leads_csv_content!;
  if(Buffer.byteLength(content)>MAX_UPLOAD_BYTES)throw new Error(`leads_csv_content is larger than ${MAX_UPLOAD_BYTES/1_000_000} MB; pass the file path as leads_csv instead.`);
  if(!content.trim())throw new Error('leads_csv_content is empty.');
  // Uploaded text is kept as an unchanging copy; the same content maps to the same dataset.
  const id=`${slug(input.leads_csv_name??'uploaded')}-u${hash(content)}`;
  const folder=join(work,id);await mkdir(folder,{recursive:true});
  const source=resolve(folder,'source.csv');
  try{await writeFile(source,content,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  return prepare(id,work,source,defaultRules,{kind:'upload',name:input.leads_csv_name??''});
}
