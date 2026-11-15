import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const script=new URL('../src/document-extract.py',import.meta.url).pathname;
test('DOCX extraction preserves paragraphs and rejects oversized decompressed text', async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pi-docx-'));
 try {
  const file=path.join(dir,'test.docx');
  const make=spawnSync('python3',['-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>')`,file],{encoding:'utf8'});
  assert.equal(make.status,0,make.stderr);
  const read=spawnSync('python3',[script,file],{encoding:'utf8'});assert.equal(read.status,0,read.stderr);assert.equal(read.stdout.trim(),'Hello\nWorld');
  spawnSync('python3',['-c',"import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('word/document.xml','x'*3000000)",file]);
  const bad=spawnSync('python3',[script,file],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/too large/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
