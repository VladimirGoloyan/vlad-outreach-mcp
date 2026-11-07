import { build } from 'esbuild';
import { z } from 'zod';
import Ajv from 'ajv';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.mjs';
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
const ajv=new Ajv({allErrors:true});
ajv.addFormat('email',/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
ajv.addFormat('uri',{type:'string',validate:value=>{try{new URL(value);return true;}catch{return false;}}});
const validate=ajv.compile(JSON.parse(await readFile('packaging/mcpb-manifest-v0.3.schema.json','utf8')));
if(!validate(manifest))throw Error(`Invalid MCPB manifest: ${ajv.errorsText(validate.errors)}`);
// Validate the supported MCPB 0.3 manifest subset and all configuration references.
const config=z.object({type:z.enum(['file','directory','string']),title:z.string().min(1),description:z.string(),required:z.boolean(),sensitive:z.boolean().optional(),default:z.string().optional()}).strict();
z.object({manifest_version:z.literal('0.3'),name:z.literal('outreach-mcp'),display_name:z.string(),version:z.string().regex(/^\d+\.\d+\.\d+$/),description:z.string(),long_description:z.string(),author:z.object({name:z.string().min(1)}),server:z.object({type:z.literal('node'),entry_point:z.literal('server/index.mjs'),mcp_config:z.object({command:z.literal('node'),args:z.array(z.string()),env:z.record(z.string(),z.string()).optional()})}),tools_generated:z.literal(true),compatibility:z.object({platforms:z.array(z.enum(['darwin','win32'])),runtimes:z.object({node:z.literal('>=20.0.0')})}),user_config:z.record(z.string(),config)}).strict().parse(manifest);
if(JSON.stringify(manifest.server.mcp_config.args)!==JSON.stringify(['${__dirname}/server/index.mjs','--working-folder','${user_config.working_folder}']))throw Error('Desktop launch path must be relative to the installed bundle');
for(const value of Object.values(manifest.server.mcp_config.env??{})){const match=/^\$\{user_config\.(\w+)\}$/.exec(value);if(!match||!manifest.user_config[match[1]])throw Error('Unknown manifest setting');}
const output=await build({entryPoints:['src/desktop.ts'],bundle:true,platform:'node',target:'node20',format:'esm',write:false,metafile:true,banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
if(output.metafile.outputs[Object.keys(output.metafile.outputs)[0]].imports.some(i=>!i.path.startsWith('node:')))throw Error('Unbundled dependency in desktop build');
const packages=[...new Set(Object.keys(output.metafile.inputs).map(path=>path.replaceAll('\\','/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))];
const notices=await Promise.all(packages.map(async name=>{
 for(const filename of ['LICENSE','LICENSE.md','LICENSE.txt']){try{return `${name}\n${await readFile(resolve('node_modules',name,filename),'utf8')}\n`;}catch{}}
 throw Error(`Missing third-party license for ${name}; add its notice before distribution`);
}));
const entries={
 'manifest.json':JSON.stringify(manifest,null,2),
 'server/index.mjs':output.outputFiles[0].contents,
 'icp.json':await readFile('icp.json'),
 'README.md':await readFile('README.md'),
 'THIRD_PARTY_NOTICES.txt':notices.join('\n')
};
await mkdir('release',{recursive:true});await writeFile('release/vlad-outreach-mcp.mcpb',zip(entries));
console.log('Created release/vlad-outreach-mcp.mcpb (official MCPB 0.3 schema validated; self-contained Node 20+ server).');
