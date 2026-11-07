// Plain-language status lines, so the user can see what the extension is doing.
// startMessage is sent as a progress update when a tool begins; finishMessage is sent when it ends and
// is also returned in the result as `activity`.

export const TOOL_TITLES:Record<string,string>={find_leads:'Find and rank leads',draft_email:'Draft outreach email'};

const count=(n:number,one:string,many=`${one}s`)=>`${n} ${n===1?one:many}`;

export function startMessage(tool:string,args:any){
  if(tool==='draft_email')return `Drafting the email for lead ${args?.lead_id??''}`.trim();
  if(args?.download_files?.length)return `Preparing ${args.download_files.join(', ')}`;
  if(args?.company_evidence?.length)return `Checking research for ${count(args.company_evidence.length,'company','companies')} against the cited pages`;
  if(args?.contact_evidence?.length)return `Checking contact details for ${count(args.contact_evidence.length,'lead')} against the cited pages`;
  return 'Reading the leads file and ranking companies';
}

export function finishMessage(tool:string,result:any){
  if(Array.isArray(result?.files))return `Ready to download: ${result.files.map((f:{filename:string})=>f.filename).join(', ')}`;
  if(tool==='draft_email'){
    if(result?.status==='research_needed')return `Company research needed before drafting for ${result.target?.company??`lead ${result.lead_id}`}`;
    const who=[result?.contact,result?.company].filter(Boolean).join(' at ')||`lead ${result?.lead_id}`;
    return `Email drafted for ${who} (${result?.angle==='company'?'company':'role'} angle). ${count(result?.drafts_so_far??1,'draft')} so far`;
  }
  const parts=[`Ranked ${count(result?.total_matches??0,'company','companies')}`,`showing the top ${result?.leads?.length??0}`];
  if(result?.other_product_rows)parts.push(`${count(result.other_product_rows.length,'KrispCX/KrispAPI row')}`);
  if(result?.lead_issues)parts.push(`${count(result.lead_issues.total,'data issue')}`);
  return parts.join(', ');
}
