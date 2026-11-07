import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { htmlToText, normalizeText, privateAddress, fetchSource } from '../src/research/sources.ts';

test('html is reduced to visible text with title and description metadata',()=>{
 const html='<html><head><title>Acme &amp; Co</title><meta name="description" content="Acme builds tools."><script>alert("x")</script><style>p{}</style></head><body><nav>Home</nav><p>Acme <strong>launched</strong> Atlas&nbsp;on&#32;October&nbsp;1,&#x20;2026.</p><!-- hidden --><div>Next</div></body></html>';
 const text=normalizeText(htmlToText(html));
 assert(text.startsWith('Acme & Co'));assert(text.includes('Acme builds tools.'));assert(text.includes('Acme launched Atlas on October 1, 2026.'));
 for(const hidden of ['alert','p{}','hidden'])assert(!text.includes(hidden));
});
test('normalization only removes typographic differences',()=>{
 assert.equal(normalizeText('“Acme’s  launch” — big news…'),'"Acme\'s launch" - big news...');
});
test('private, loopback, link-local and mapped addresses are refused',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1','::ffff:7f00:1'])assert(privateAddress(ip),ip);
 for(const ip of ['93.184.216.34','8.8.8.8','2606:4700::1111'])assert(!privateAddress(ip),ip);
});
test('fetchSource refuses local targets, odd ports, credentials and non-web schemes before connecting',async()=>{
 let hits=0;const server=createServer((_req,res)=>{hits++;res.end('<p>secret</p>');});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const port=(server.address() as any).port;
 try{
  for(const url of [`http://127.0.0.1:${port}/`,'http://127.0.0.1/','http://localhost/','http://[::1]/','http://169.254.169.254/latest/meta-data','ftp://example.com/','file:///etc/hosts','https://user:pw@example.com/','http://intranet.local/'])
   await assert.rejects(fetchSource(url),undefined,url);
  assert.equal(hits,0);
 }finally{server.close();}
});
test('addresses published only as mailto links are part of the page text',()=>{
 const text=normalizeText(htmlToText('<p>Jane Smith <a href="mailto:jane.smith%40acme.com?subject=hi">Email Jane</a></p>'));
 assert(text.includes('mailto: jane.smith@acme.com'));
});
