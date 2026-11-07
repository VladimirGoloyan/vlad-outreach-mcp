import { columns, type Lead } from './model.ts';

// RFC 4180 fields, including quoted commas, newlines and doubled quotes.
export function parseCsv(text:string): Lead[] {
  text=text.replace(/^\uFEFF/,'');
  const records:string[][]=[]; let row:string[]=[]; let cell=''; let quoted=false; let closed=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) { if(c==='"') {if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c; continue; }
    if(c==='"' && !cell && !closed) {quoted=true;continue;}
    if(c===',' || c==='\n' || c==='\r') {
      row.push(cell);cell='';closed=false;
      if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++; if(row.some(v=>v!==''))records.push(row);row=[];}
      continue;
    }
    if(closed || c==='"')throw new Error(`Malformed CSV near character ${i}`);
    cell+=c;
  }
  if(quoted)throw new Error('CSV has an unclosed quoted field');
  if(cell || row.length || closed){row.push(cell);records.push(row);}
  const headers=records.shift()?.map(h=>h.trim());
  if(!headers || new Set(headers).size!==headers.length || headers.length!==columns.length || columns.some(c=>!headers.includes(c)))throw new Error(`CSV headers must be: ${columns.join(',')}`);
  const ids=new Set<string>();
  return records.map((r,i)=>{
    if(r.length!==headers.length)throw new Error(`CSV row ${i+2}: expected ${headers.length} fields`);
    const l=Object.fromEntries(headers.map((h,j)=>[h,r[j].trim()])) as Lead;
    if(!l.lead_id || ids.has(l.lead_id))throw new Error(`CSV row ${i+2}: missing or duplicate lead_id`);
    if(l.headcount && !/^\d+$/.test(l.headcount))throw new Error(`CSV row ${i+2}: headcount must be a nonnegative integer`);
    ids.add(l.lead_id);return l;
  });
}
export function serializeCsv(leads:Lead[]):string {
  const escape=(s:string)=>/[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;
  return [columns.join(','),...leads.map(l=>columns.map(c=>escape(l[c])).join(','))].join('\r\n')+'\r\n';
}
