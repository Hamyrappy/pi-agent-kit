import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanJobs } from '../src/scheduler.mjs';
test('scheduler runs due authorized jobs, waits for future and quarantines invalid destinations', async () => {
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'pi-jobs-'));
 try {
  const dir=path.join(stateDir,'jobs'); await mkdir(dir);
  const job={dueAt:'2026-01-01T00:00:00Z',chatId:42,prompt:'Report'};
  await writeFile(path.join(dir,'due.json'),JSON.stringify(job));
  await writeFile(path.join(dir,'future.json'),JSON.stringify({...job,dueAt:'2099-01-01T00:00:00Z'}));
  await writeFile(path.join(dir,'denied.json'),JSON.stringify({...job,chatId:99}));
  const calls=[];const bridge={enqueue:async j=>calls.push(j)};
  await scanJobs(bridge,{stateDir,telegram:{allowedUserIds:[42]}},{now:Date.parse('2026-01-02'),log:()=>{}});
  assert.equal(calls.length,1);assert.equal(calls[0].sourceId,'job:due.json');
  assert.deepEqual(await readdir(path.join(dir,'done')),['due.json']);
  assert.deepEqual(await readdir(path.join(dir,'failed')),['denied.json']);
  await scanJobs(bridge,{stateDir,telegram:{allowedUserIds:[42]}},{now:Date.parse('2026-01-02'),log:()=>{}});
  assert.equal(calls.length,1);
 } finally {await rm(stateDir,{recursive:true,force:true});}
});
