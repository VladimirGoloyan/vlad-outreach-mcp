export const priorityCountries=['United States','Philippines','India','United Kingdom','Brazil','Colombia','Mexico'];
export const country=(value:string)=>{
 const normalized=value.trim().toLowerCase().replace(/[.]/g,'');
 const aliases:Record<string,string>={us:'United States',usa:'United States','united states of america':'United States',uk:'United Kingdom',gb:'United Kingdom',britain:'United Kingdom','great britain':'United Kingdom',ph:'Philippines',in:'India',br:'Brazil',co:'Colombia',mx:'Mexico'};
 return aliases[normalized]??priorityCountries.find(c=>c.toLowerCase()===normalized)??value.trim();
};
export const fitCue=(product:string,text:string)=>!/(?:no|not|without|does not|doesn't)\s+(?:\w+\s+){0,3}(?:voice|audio|contact.center|call.center)/i.test(text)&&(product==='krispcx'?/contact[ -]?cent(?:er|re)|call[ -]?cent(?:er|re)|\bbpo\b|customer (?:support|service).{0,80}(?:phone|voice|calls)/i.test(text):product==='krispapi'?/(voice|audio|video calls?|speech)/i.test(text)&&/(product|platform|app|game|sdk|api|embedded|in-app|in-game)/i.test(text):/(meetings?|remote (?:work|teams)|client calls|sales calls|video conferencing)/i.test(text));
export function countryMention(text:string,value:string){
 const c=country(value);const aliases:Record<string,string[]>={'United States':['United States','USA','U.S.','US'],'United Kingdom':['United Kingdom','UK','U.K.','Britain'],'Philippines':['Philippines'],'India':['India'],'Brazil':['Brazil','Brasil'],'Colombia':['Colombia'],'Mexico':['Mexico','México']};
 return (aliases[c]??[c]).some(alias=>new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:\\b|$)`,alias.length<=4?'':'i').test(text));
}
