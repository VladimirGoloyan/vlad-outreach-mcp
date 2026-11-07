import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DOWNLOADS, type Service } from './service.ts';
import type { DatasetSource } from './desktop-config.ts';
import { TOOL_TITLES, startMessage, finishMessage } from './activity.ts';
import { evidenceSchema, contactEvidenceSchema } from './research/evidence.ts';

export const VERSION='1.0.0';
type LeadsOptions=Parameters<Service['prepareLeads']>[0];
type DraftArgs=Parameters<Service['prepareDraft']>;
/** What the tools call. Every call also names its leads CSV. */
export type Backend={prepareLeads(options:LeadsOptions,source:DatasetSource):Promise<unknown>;prepareDraft(...args:[...DraftArgs,DatasetSource]):Promise<unknown>};
const fileArgs={
  leads_csv:z.string().trim().min(1).max(1000).optional().describe('Absolute path to the leads CSV on this computer. Use when the user gives or mentions a file path'),
  leads_csv_content:z.string().max(5_000_000).optional().describe('Full, unmodified text of a CSV the user attached in chat (copy every row). Use when there is no local path'),
  leads_csv_name:z.string().trim().max(200).optional().describe('File name of the attached CSV, e.g. "leads.csv"'),
  dataset_id:z.string().trim().min(1).max(80).optional().describe('dataset_id returned by an earlier call. Use it for every follow-up call on the same file instead of resending it'),
};

/**
 * Sent to the client when it connects; Claude Desktop shows it to Claude in every conversation
 * where the extension is enabled. It decides whether Claude reaches for these tools at all.
 */
export function serverInstructions(){
  return [
    'Vlad Outreach MCP is the user\'s own tool for Krisp sales prospecting. Use it, not web search and not your own analysis of the file, whenever the user wants to find, pick, rank, audit, clean up, research or email leads or prospects for KrispWork, KrispCX or KrispAPI, or asks for the "top"/"best" leads or contacts in a leads list or CSV.',
    'The leads file is supplied per call. If the user attached a CSV in chat, call find_leads with its full text as leads_csv_content (and the file name as leads_csv_name); do not parse, score or summarise the attachment yourself first. If they give a file path, pass it as leads_csv. If they say they will attach a file, tell them you will run it through Vlad Outreach MCP once it arrives. After the first call, use the returned dataset_id. If no file has been given, ask for one.',
    'find_leads applies the configured KrispWork ideal-customer rules, keeps one best contact per company, checks emails locally, flags KrispCX/KrispAPI handoffs, and ranks in two steps: company_score (is the company worth targeting: size, priority country, call-heavy industry, verified research) first, then contact_score (how good the contact there is: email readiness, seniority, call-heavy role, full name). Each lead has rank, company_score, contact_score and their reasons. For "top N leads" call it with limit N and present those N in rank order as a table (rank, company, company score, contact name and title, contact score, main reasons, email status). Use the tool\'s scores; do not invent your own. The KrispCX/KrispAPI table comes from find_leads.other_product_rows; find_leads.handoffs holds the company-level detail behind it: status "active" is confirmed by research; status "potential" is suggested by industry or an explicit title and still needs research (give its fit.reason). Potential entries can be companies outside the KrispWork list, and lead_id null means there is no suitable contact there yet.',
    'Every reply to a find_leads request has five sections, in this order (find_leads.response_sections repeats them): 1) Ranked leads table. 2) Draft emails: without waiting to be asked, call draft_email for each ranked lead in rank order (at most 10 unless the user asked for more; offer the rest) and show the drafts as returned. 3) KrispCX / KrispAPI leads: this is important and must always be a SEPARATE table under its own heading (never mixed into the KrispWork table or the drafts). One row per contact and product line from find_leads.other_product_rows, with columns: product line (KrispCX or KrispAPI), status (active = confirmed by research, potential = needs research), company, contact name and title, email, role suits product (yes/no), selected contact (yes/no), reason. If other_product_rows is empty, still show the heading and say no KrispCX or KrispAPI leads were found. The same table is downloadable as other-product-leads.csv. 4) Suggestions: summarise find_leads.lead_issues (errors first, then warnings, grouped by issue with the lead IDs and suggested fix), pending correction proposals and research_warnings, and suggest useful next steps such as researching potential KrispCX/KrispAPI companies or enrich_missing for missing fields. Only suggest fixes; never change leads without explicit approval. Skip the drafts only if the user says not to draft.',
    'Drafting: Drafts are formal ("Dear Mr Smith," when a salutation is known, otherwise "Dear Jane Smith,"; "Kind regards"), tidy capitalisation and spacing of names, titles and company names from the leads file (listed in lead_data_corrections; the file itself is not changed), and are kept with the dataset (nothing is written to the computer of the user). Drafts are signed as Vlad and already explain KrispWork features and ask for a meeting, so do not ask for a sender name or offer; pass sender_name or offer only if the user gives them. Senior contacts (founders, C-level, VPs, heads, directors) get a company-angle email (why their company needs Krisp); everyone else gets a role-angle email (why they need Krisp in their own work). Then call draft_email for each lead in rank order. If it returns status "research_needed", do a quick web search for that company; submit verified quotes as company_evidence if you find a page clearly about that exact company, otherwise call draft_email again with personalization: "lead_data" (this is expected for unknown companies and placeholder domains). Drafts are always produced; when ready_to_send is false, show the not_ready_reasons next to the draft. Present the drafts exactly as returned.',
    'Downloads: files are never saved automatically. 5) End every reply that shows drafts with this question: "Would you like to download your drafted emails? drafts.md (easy to read) or drafts.csv (spreadsheet)." and list any other files in downloads_available. Do not save, write or export these files on your own, and do not report a folder or path as the result. Only after the user says yes, call find_leads with download_files. Then hand over each returned file, with its exact name and content, using whatever your app offers for giving the user a downloadable file (file creation, an artifact, or a send-file or present-file tool). A temporary copy is fine if your app needs one to present the file, but never put it in the project folder or beside the leads file. If your app has no way to give a file, say so and show the content in a code block to copy.',
    'Keep the user informed so they can see the work is moving: before every tool call or research step, write one short plain line saying what you are about to do (for example "Reading your leads file and ranking companies...", "Researching Harbor Insurance...", "Drafting 3 of 10: Orbit Fintech..."), and never go silent during a long run. Each tool result has an activity line you can repeat when it helps.',
    'Use your web tools only for research a tool result asks for (research_requests, enrichment_requests or status "research_needed"), following the returned instructions, and submit the findings back through the tools. Never apply contact corrections without the user\'s explicit approval. Emails are drafted only with draft_email and are never sent.',
  ].join('\n\n');
}

export function createServer(service:Backend){
  const fileNote=' Name the leads file with exactly one of leads_csv (path), leads_csv_content (attached CSV text) or dataset_id (from an earlier result).';
  const source=(a:any):DatasetSource=>({leads_csv:a.leads_csv,leads_csv_content:a.leads_csv_content,leads_csv_name:a.leads_csv_name,dataset_id:a.dataset_id});
  const strip=(a:any)=>{const {leads_csv:_1,leads_csv_content:_2,leads_csv_name:_3,dataset_id:_4,...rest}=a;return rest;};
  const server=new McpServer({name:'outreach-mcp',version:VERSION},{instructions:serverInstructions()});
  const id=z.string().trim().min(1).max(100);
  const researchNote='Research is done by you with your own web search/fetch tools and submitted as company_evidence or contact_evidence; the extension downloads every cited page and keeps only quotes found there verbatim. Never invent or paraphrase evidence.';
  function register(name:string,description:string,schema:z.ZodObject,handler:(args:any)=>Promise<unknown>|unknown,readOnly=true){
    server.registerTool(name,{title:TOOL_TITLES[name],description,inputSchema:schema,annotations:{title:TOOL_TITLES[name],readOnlyHint:readOnly,destructiveHint:false,openWorldHint:!readOnly}},async (args,ctx)=>{
      // Progress updates are best-effort: clients that do not ask for them simply get none, and a failed update never fails the tool.
      const token=ctx.mcpReq._meta?.progressToken;
      const report=async(progress:number,message:string)=>{if(token===undefined)return;await ctx.mcpReq.notify({method:'notifications/progress',params:{progressToken:token,progress,total:1,message}}).catch(()=>{});};
      try{
        // The log gets the start line only; finish lines carry contact names and the log may be shared for support.
        console.error(`Vlad Outreach MCP: ${startMessage(name,args)}`);
        await report(0,startMessage(name,args));
        const result=await handler(args) as any;
        const activity=finishMessage(name,result);if(result&&typeof result==='object')result.activity=activity;
        await report(1,activity);
        // Downloadable files go out as attachments (embedded resources) as well as in the JSON.
        const files:{filename:string;mime_type:string;content:string}[]=Array.isArray(result?.files)?result.files:[];
        return {content:[{type:'text' as const,text:JSON.stringify(result)},...files.map(f=>({type:'resource' as const,resource:{uri:`outreach://downloads/${encodeURIComponent(f.filename)}`,mimeType:f.mime_type,text:f.content}}))]};
      }
      catch(e){await report(1,'Stopped: the tool hit an error');return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Tool failed'}]};}
    });
  }
  register('find_leads',`Use for any request to find, list, pick, rank, audit or clean up KrispWork leads (and KrispCX/KrispAPI opportunities) from a leads CSV, including a CSV the user attached in chat, and for "top N leads" requests. Use this instead of analysing the CSV yourself or searching the web.${fileNote} Returns one best KrispWork contact per eligible company, ranked by company_score first and contact_score second (rank, both scores and their reasons; limit = number of companies, so "top 10" means limit 10), local email checks, top_lead regional markers, data-quality findings, correction proposals, KrispCX/KrispAPI handoffs (confirmed "active" first, then "potential" ones suggested by industry, including companies with no KrispWork contact), other_product_rows (every CSV row at a company that fits KrispCX/KrispAPI), lead_issues (data errors and warnings with suggested fixes) and response_sections (the layout for your reply: ranked list, draft emails via draft_email, a separate KrispCX/KrispAPI table, suggestions, then the download question) and downloads_available (files to offer the user; fetch them with download_files only after they agree). Optional follow-ups: research:true returns research_requests for companies lacking verified research; research them and call again with company_evidence (one entry per company, keyed by lead_id). enrich_missing:true returns enrichment_requests for leads with missing names/title/headcount or unusable emails; research them and call again with contact_evidence to create correction proposals. Never guess emails. Apply corrections only with approved_proposal_ids the user explicitly approved. ${researchNote}`,z.object({
    limit:z.number().int().min(1).max(100).default(20).describe('Number of top-ranked companies to return (default 20, max 100). For "top N", use N'),
    order:z.enum(['score','csv']).default('score').describe('score: ranked by company score, then contact score (default); csv: original file order'),
    lead_ids:z.array(id).min(1).max(100).optional().describe('Limit research, enrichment and data-quality detail to these leads'),
    research:z.boolean().default(false).describe('Request company research (icebreakers, product fit, locations) for the leads'),
    enrich_missing:z.boolean().default(false).describe('Request research for missing or unusable contact fields'),
    approved_proposal_ids:z.array(id).min(1).max(100).optional().describe('Correction proposals the user explicitly approved'),
    company_evidence:z.array(evidenceSchema.extend({lead_id:id})).min(1).max(10).optional(),
    contact_evidence:z.array(contactEvidenceSchema.extend({lead_id:id})).min(1).max(20).optional(),
    download_files:z.array(z.enum(DOWNLOADS)).min(1).max(DOWNLOADS.length).optional().describe('Only after the user agreed to download: the files they want. Returns just those files, attached, and nothing else'),
    ...fileArgs}).strict(),a=>service.prepareLeads(strip(a),source(a)),false);
  register('draft_email',`Use to write a personalized outreach email to a lead returned by find_leads (draft only, never sent). Use this instead of writing the email yourself.${fileNote} Personalizes with a verified, sourced company fact when one is saved. Otherwise it returns status "research_needed": research the company with your web tools and call again with company_evidence, or, if nothing verifiable exists for that company, call again with personalization: "lead_data" to personalize from the lead's title, company and industry. A draft is produced even when the email address or name is not usable; check ready_to_send and not_ready_reasons. Ownership/deliverability of the address remain unverified. Never applies lead corrections. Drafts are kept with the dataset, not saved as files: after the last draft, ask whether the user wants to download them, and get the files with find_leads download_files only if they say yes. ${researchNote}`,z.object({
    lead_id:id.describe('lead_id from find_leads'),
    icebreaker_id:id.optional().describe('A specific saved icebreaker from find_leads.company_research'),
    company_website:z.url().refine(u=>/^https?:/.test(u)).optional().describe('Official company homepage, when the lead email domain does not identify the company'),
    sender_name:z.string().trim().min(1).max(80).refine(v=>!/[\r\n]/.test(v)).optional().describe('Name to sign the email with (default: Vlad)'),
    offer:z.string().trim().max(400).optional().describe('Optional extra sentence or two to add; the draft already explains KrispWork features and asks for a meeting'),
    company_evidence:evidenceSchema.optional(),
    salutation:z.enum(['Mr','Ms','Mrs','Dr','Prof']).optional().describe('Formal salutation for "Dear Mr Smith,". Pass it only when the user gave it or a source clearly states it (e.g. "Mr Smith", "she"/"he" on the company site); never infer it from the first name. Without it the greeting is "Dear Jane Smith,"'),
    personalization:z.enum(['auto','lead_data']).default('auto').describe('auto: verified company research (asks for research if none is saved); lead_data: if no verified research is saved, personalize from the lead\'s CSV details instead of asking for research'),
    ...fileArgs}).strict(),a=>service.prepareDraft(a.lead_id,a.sender_name,a.offer,a.icebreaker_id,a.company_website,a.company_evidence,a.personalization,a.salutation,source(a)),false);
  return server;
}
