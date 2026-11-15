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

test('recurring jobs skip missed slots, stay bounded, and support owner-scoped cancellation', async () => {
 const {listJobs,cancelJob}=await import('../src/scheduler.mjs');
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'pi-repeat-'));
 try {
  const dir=path.join(stateDir,'jobs');await mkdir(dir);
  const config={stateDir,telegram:{allowedUserIds:[42]}};
  await writeFile(path.join(dir,'daily.json'),JSON.stringify({dueAt:'2026-01-01T10:00:00Z',chatId:42,prompt:'Report',everySeconds:86400,remainingRuns:3}));
  const calls=[];const bridge={enqueue:async j=>calls.push(j)};
  await scanJobs(bridge,config,{now:Date.parse('2026-01-04T12:00:00Z')});
  assert.equal(calls.length,1);
  const jobs=await listJobs(config,42);assert.equal(jobs.length,1);assert.equal(jobs[0].dueAt,'2026-01-05T10:00:00.000Z');assert.equal(jobs[0].remainingRuns,2);
  assert.deepEqual(await listJobs(config,99),[]);
  assert.equal(await cancelJob(config,99,'daily'),false);
  assert.equal(await cancelJob(config,42,'../daily'),false);
  assert.equal(await cancelJob(config,42,'daily'),true);
  await scanJobs(bridge,config,{now:Date.parse('2026-01-06T12:00:00Z')});assert.equal(calls.length,1);
 } finally {await rm(stateDir,{recursive:true,force:true});}
});
test('an invalid face does not prevent a later valid due job',async()=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'pi-badjob-'));
 try {
  const dir=path.join(stateDir,'jobs');await mkdir(dir);
  const job={dueAt:'2026-01-01T00:00:00Z',chatId:42,prompt:'Report'};
  await writeFile(path.join(dir,'a-invalid.json'),JSON.stringify({...job,face:'../bad'}));
  await writeFile(path.join(dir,'b-valid.json'),JSON.stringify(job));
  const calls=[];await scanJobs({enqueue:async j=>calls.push(j)},{stateDir,telegram:{allowedUserIds:[42]}},{now:Date.parse('2026-01-02'),log:()=>{}});
  assert.equal(calls.length,1);
 } finally {await rm(stateDir,{recursive:true,force:true});}
});
test('cancel racing a recurring scan prevents every future occurrence',async()=>{
 const {cancelJob,listJobs}=await import('../src/scheduler.mjs');
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'pi-cancel-race-'));
 try {
  const dir=path.join(stateDir,'jobs');await mkdir(dir);
  const config={stateDir,telegram:{allowedUserIds:[42]}};
  await writeFile(path.join(dir,'repeat.json'),JSON.stringify({dueAt:'2026-01-01T00:00:00Z',chatId:42,prompt:'Report',everySeconds:3600,remainingRuns:3}));
  let release,started;const wait=new Promise(r=>release=r);const entered=new Promise(r=>started=r);
  const scanning=scanJobs({enqueue:async()=>{started();await wait;}},config,{now:Date.parse('2026-01-01T00:01:00Z')});
  await entered;const cancelling=cancelJob(config,42,'repeat');release();
  await scanning;assert.equal(await cancelling,true);assert.deepEqual(await listJobs(config,42),[]);
 } finally {await rm(stateDir,{recursive:true,force:true});}
});
