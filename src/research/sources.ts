// Keyless source fetching used to verify research evidence that Claude cites.
// Pages are untrusted data: they are only searched for exact quotes, never interpreted.
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

export type SourcePage = {url:string;markdown:string};
export type FetchPage = (url:string)=>Promise<SourcePage>;

const MAX_BYTES=3_000_000, MAX_TEXT=500_000, MAX_REDIRECTS=5, TIMEOUT_MS=15_000;
const USER_AGENT='Mozilla/5.0 (compatible; OutreachMCP/1.0; source verification)';

/** Canonical form used on both page text and quotes so typography differences do not break exact matching. */
export function normalizeText(value:string){
  return value.normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g,"'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g,'"')
    .replace(/[\u2010-\u2015\u2212]/g,'-').replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g,'')
    .replace(/\s+/g,' ').trim();
}

const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',rsquo:'\u2019',lsquo:'\u2018',rdquo:'\u201D',ldquo:'\u201C',ndash:'\u2013',mdash:'\u2014',hellip:'\u2026',copy:'\u00A9',reg:'\u00AE',trade:'\u2122',middot:'\u00B7',bull:'\u2022',eacute:'\u00E9',aacute:'\u00E1',iacute:'\u00ED',oacute:'\u00F3',uacute:'\u00FA',ntilde:'\u00F1',ccedil:'\u00E7',uuml:'\u00FC',ouml:'\u00F6',auml:'\u00E4',szlig:'\u00DF'};
export function decodeEntities(value:string){
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(match,code:string)=>{
    if(code[0]==='#'){const n=code[1]==='x'||code[1]==='X'?parseInt(code.slice(2),16):parseInt(code.slice(1),10);return Number.isFinite(n)&&n>0&&n<=0x10FFFF?String.fromCodePoint(n):match;}
    return entities[code.toLowerCase()]??match;
  });
}
const BLOCK=/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|pre|hr|dt|dd|dl|figure|figcaption|form|label|button|option|summary|details|time|address)\b[^>]*>/gi;
/** Visible text plus title and description metadata, in reading order. */
export function htmlToText(html:string){
  const parts:string[]=[];
  const title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];if(title)parts.push(title);
  for(const tag of html.match(/<meta\s[^>]*>/gi)??[]){
    const name=/\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content=/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if(name&&['description','og:description','og:title','twitter:description'].includes(name)&&content)parts.push(content[1]??content[2]??'');
  }
  const body=html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi,' ').replace(BLOCK,' \n ').replace(/<[^>]*>/g,'');
  parts.push(body);
  // Addresses published only as mailto links are part of the page too.
  for(const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)){try{parts.push('mailto: '+decodeURIComponent(m[1]));}catch{parts.push('mailto: '+m[1]);}}
  return parts.map(decodeEntities).join('\n');
}

export function privateAddress(address:string):boolean{
  const v4=(ip:string)=>{const o=ip.split('.').map(Number);if(o.length!==4||o.some(n=>!Number.isInteger(n)||n<0||n>255))return true;const [a,b]=o;
    return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0&&o[2]===0)||(a===198&&(b===18||b===19));};
  if(isIP(address)===4)return v4(address);
  if(isIP(address)!==6)return true;
  const ip=address.toLowerCase().replace(/^\[|\]$/g,'');
  const mapped=/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1]??/^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if(mapped)return v4(mapped);
  if(/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip))return true;
  return ip==='::'||ip==='::1'||/^f[cd]/.test(ip)||/^fe[89ab]/.test(ip)||/^ff/.test(ip)||/^64:ff9b:/.test(ip)||/^2001:db8:/.test(ip);
}
// Resolves through DNS and refuses private, loopback and link-local targets at connection time,
// so a hostname cannot be re-pointed at the local network between checking and connecting.
const safeLookup=((hostname:string,options:any,callback:any)=>{
  dnsLookup(hostname,{...options,all:true},(error,addresses:any)=>{
    if(error)return callback(error);
    const list=(addresses as {address:string;family:number}[]);
    if(!list.length||list.some(a=>privateAddress(a.address)))return callback(Object.assign(new Error('Refusing to fetch a private or local network address'),{code:'EPRIVATE'}));
    if(options?.all)return callback(null,list);
    callback(null,list[0].address,list[0].family);
  });
}) as any;

function checkUrl(url:URL){
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error('Only http and https sources are supported');
  if(url.username||url.password)throw new Error('Source URLs must not contain credentials');
  if(url.port)throw new Error('Source URLs must use the default web port');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(isIP(host)&&privateAddress(host))throw new Error('Refusing to fetch a private or local network address');
  if(/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))throw new Error('Refusing to fetch a local hostname');
}
type Response={status:number;headers:http.IncomingHttpHeaders;body:Buffer};
function request(url:URL,signal:AbortSignal):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const client=url.protocol==='https:'?https:http;
    const req=client.request(url,{method:'GET',signal,lookup:safeLookup,headers:{'user-agent':USER_AGENT,accept:'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1','accept-language':'en','accept-encoding':'gzip, deflate, br'}},res=>{
      const status=res.statusCode??0;
      if(status>=300&&status<400){res.resume();return resolve({status,headers:res.headers,body:Buffer.alloc(0)});}
      const encoding=String(res.headers['content-encoding']??'').toLowerCase();
      let stream:Readable=res;
      if(encoding==='gzip'||encoding==='x-gzip')stream=res.pipe(zlib.createGunzip());
      else if(encoding==='deflate')stream=res.pipe(zlib.createInflate());
      else if(encoding==='br')stream=res.pipe(zlib.createBrotliDecompress());
      const chunks:Buffer[]=[];let size=0;let done=false;
      const finish=()=>{if(done)return;done=true;resolve({status,headers:res.headers,body:Buffer.concat(chunks)});};
      stream.on('data',(chunk:Buffer)=>{if(done)return;chunks.push(chunk);size+=chunk.length;if(size>=MAX_BYTES){finish();res.destroy();}});
      stream.on('end',finish);
      stream.on('error',error=>{if(!done){done=true;reject(error);}});
    });
    req.on('error',reject);req.end();
  });
}
const site=(host:string)=>host.toLowerCase().replace(/^www\./,'');

/** Download a public web page and return its normalized visible text. */
export async function fetchSource(raw:string):Promise<SourcePage>{
  const original=new URL(raw);checkUrl(original);
  const signal=AbortSignal.timeout(TIMEOUT_MS);
  let url=original;
  for(let hop=0;;hop++){
    let response:Response;
    try{response=await request(url,signal);}
    catch(error){const e=error as NodeJS.ErrnoException;throw new Error(e.code==='EPRIVATE'?e.message:e.name==='AbortError'||e.name==='TimeoutError'?'Timed out downloading the page':`Download failed (${e.code??e.message})`);}
    if(response.status>=300&&response.status<400){
      if(hop>=MAX_REDIRECTS||!response.headers.location)throw new Error('Too many or invalid redirects');
      url=new URL(response.headers.location,url);checkUrl(url);continue;
    }
    if(response.status<200||response.status>=300)throw new Error(`The site returned HTTP ${response.status}`);
    if(site(url.hostname)!==site(original.hostname))throw new Error(`The page redirects to another site (${url.href}); cite that final URL instead`);
    const type=String(response.headers['content-type']??'text/html').toLowerCase();
    const html=/html|xml/.test(type);
    if(!html&&!type.startsWith('text/plain'))throw new Error(`Unsupported content type ${type.split(';')[0]}; cite an HTML page`);
    const charset=/charset=([\w-]+)/.exec(type)?.[1]??'utf-8';
    let text:string;try{text=new TextDecoder(charset).decode(response.body);}catch{text=new TextDecoder('utf-8').decode(response.body);}
    const markdown=normalizeText(html?htmlToText(text):text).slice(0,MAX_TEXT);
    if(!markdown)throw new Error('The page has no readable text (it may need JavaScript); cite a different page');
    return {url:raw,markdown};
  }
}
