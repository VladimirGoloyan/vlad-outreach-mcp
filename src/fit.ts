import { z } from 'zod';
export const priorityCountries=['United States','Philippines','India','United Kingdom','Brazil','Colombia','Mexico'];
// Industries whose work runs on phone and video calls; matched as case-insensitive substrings.
export const callHeavyIndustries=["Logistics","Supply Chain","Freight","Shipping","Transport","BPO","Outsourcing","Call Center","Call Centre","Contact Center","Contact Centre","Customer Service","Insurance","Financial Services","Banking","Lending","Mortgage","Fintech","Recruiting","Staffing","HR Services","Consulting","Professional Services","Legal","Accounting","Real Estate","Telecom","Travel","Hospitality","Healthcare","Telehealth"];
// Without research, KrispCX/KrispAPI "potential" comes from the company's industry (case-insensitive substring),
// or from a title that names the use case outright. General titles (COO, operations, engineering) are not enough.
export const cxIndustries=["BPO","Outsourcing","Call Center","Call Centre","Contact Center","Contact Centre","Customer Service","Customer Support","Customer Experience","Telecom","Insurance","Banking","Utilities","Airline"];
export const cxTitles=/contact cent(er|re)|call cent(er|re)|customer (service|support|care) (agent|representative|rep|specialist|manager|director|lead|team)|head of customer (service|support|care)|(vp|director) of customer (service|support|care)/i;
export const apiIndustries=["Gaming","Games","Telehealth","Telemedicine","Healthcare Technology","Health Tech","Education Technology","Edtech","Tutoring","Voice","Speech","Conferencing","Communications Platform","CPaaS","Social","Dating","Metaverse"];
export const apiTitles=/\bvoice\b|\baudio\b|speech|\bvoip\b|real-?time communication|\brtc\b/i;
export const products=['krispwork','krispcx','krispapi'] as const;
export const evidenceSchema=z.object({source_url:z.url().refine(u=>/^https?:/.test(u)),excerpt:z.string().min(1).max(4000)});
export const fitSchema=z.object({product:z.enum(products),status:z.enum(['supported','potential','insufficient_evidence']),reason:z.string().max(2000),evidence:z.array(evidenceSchema).max(10)});
export const locationSchema=evidenceSchema.extend({country:z.string().min(1),presence_type:z.enum(['office','employees'])});
export type Fit=z.infer<typeof fitSchema>;
export { country, fitCue } from './research/signals.ts';
