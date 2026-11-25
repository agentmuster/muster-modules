import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {prFingerprint, type ModuleContext} from '@agentmuster/module-sdk';
import prModule, {checkBlockers, parsePrUrl, snapshot} from '../index.ts';

const url = 'https://bitbucket.org/acme/server/pull-requests/123';
const sha = 'a'.repeat(40), target = 'b'.repeat(40);
const diff = 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new\n';

function fixture() {
  let pr: any = {id: 123, title: 'Fix redirect', description: 'Keep the callback URL.', state: 'OPEN', author: {uuid: 'author'},
    source: {commit: {hash: sha.slice(0, 12)}, branch: {name: 'fix'}}, destination: {commit: {hash: target.slice(0, 12)}, branch: {name: 'staging'}},
    participants: [{approved: true, user: {uuid: 'reviewer'}}]};
  const data = {
    pr, diff, checks: {checks: [{key: 'git_mergeability_check', name: 'Conflicts', status: 'PASSED', blocking: false}]},
    statuses: [{state: 'SUCCESSFUL', name: 'tests'}] as any[], tasks: [] as any[], conflicts: [] as any[], denied: '', mergedState: 'MERGED',
    writes: [] as any[],
    full: {source: sha, destination: target},
  };
  const ctx: ModuleContext = {
    settings: {username: 'owner@example.test', minApprovals: 1, allowedBranches: 'staging, main'},
    secret: () => 'fake-token', log() {},
    async fetch(raw, options) {
      assert.equal(new Headers(options?.headers).get('authorization'), 'Basic ' + Buffer.from('owner@example.test:fake-token').toString('base64'));
      const commit = /\/2\.0\/repositories\/acme\/server\/commit\/([a-f0-9]+)$/.exec(new URL(raw).pathname);
      if (commit) {
        // Bitbucket's PR object has 12-character hashes; the commit endpoint returns the full one.
        const full = [data.full.source, data.full.destination].find(hash => hash.startsWith(commit[1]));
        return full ? Response.json({hash: full}) : new Response('{}', {status: 404});
      }
      const route = new URL(raw).pathname.replace('/2.0/repositories/acme/server/pullrequests/123', '') || '/';
      if (route === data.denied) return new Response('{}', {status: 403});
      if (options?.method === 'POST') {
        assert.equal(route, '/merge');
        data.writes.push(JSON.parse(String(options.body)));
        return Response.json({state: data.mergedState});
      }
      if (route === '/') return Response.json(data.pr);
      if (route === '/diff') return new Response(data.diff);
      if (route === '/statuses') return Response.json({values: data.statuses});
      if (route === '/tasks') return Response.json({values: data.tasks});
      if (route === '/conflicts') return Response.json({values: data.conflicts});
      if (route === '/mergeability/checks') return Response.json(data.checks);
      throw new Error('Unexpected request: ' + raw);
    },
  };
  return {ctx, data};
}

test('PR links are canonical Bitbucket Cloud links and nothing else', () => {
  assert.equal(parsePrUrl(url + '?x=1#y').url, url);
  for (const bad of ['http://bitbucket.org/acme/server/pull-requests/1', 'https://bitbucket.org.evil/acme/server/pull-requests/1', 'https://u:p@bitbucket.org/acme/server/pull-requests/1', 'https://bitbucket.org/acme/server/pull-requests/new']) assert.throws(() => parsePrUrl(bad));
});

test('the module declares a pull-request provider whose merge action is gated by the owner\'s review', async () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'muster-module.json'), 'utf8'));
  assert.deepEqual(manifest.providers.pullRequests.links, [{host: 'bitbucket.org', path: '/{owner}/{repo}/pull-requests/{number}'}]);
  const merge = manifest.actions.find((a: any) => a.id === manifest.providers.pullRequests.mergeAction);
  assert.equal(merge.policy, 'reviewed-pr');
  assert.equal(merge.confirm, 'always');
  const {ctx} = fixture();
  const viaProvider = await prModule.providers!.pullRequests!.snapshot(ctx, {url});
  assert.equal(viaProvider.url, url);
  assert.equal(viaProvider.fingerprint, prFingerprint(url, sha, target, diff), 'the fingerprint is the one Muster computes');
});

test('a PR snapshot pins the source, destination and complete diff and checks the live gates', async () => {
  const {ctx, data} = fixture();
  const state = await snapshot(ctx, {url});
  assert.equal(state.source, sha);
  assert.equal(state.destination, target);
  assert.equal(state.diff, diff);
  assert.equal(state.fingerprint.length, 64);
  assert.deepEqual(state.blockers, []);
  // A PR without builds can merge, even if an old saved setting asks for one; failed or pending builds still block.
  data.statuses = [];
  assert.deepEqual((await snapshot({...ctx, settings: {...ctx.settings, requireBuild: 'yes'}}, {url})).blockers, []);
  data.statuses = [{state: 'INPROGRESS'}];
  assert.match((await snapshot(ctx, {url})).blockers.join(' '), /pending/);
  data.statuses = [{state: 'SUCCESSFUL', name: 'tests'}];
  data.pr.draft = true;
  data.pr.participants = [{approved: true, user: {uuid: 'author'}}];
  data.statuses = [{state: 'INPROGRESS'}];
  data.tasks = [{state: 'UNRESOLVED'}];
  data.conflicts = [{path: 'test.ts'}];
  const blocked = await snapshot(ctx, {url});
  assert.match(blocked.blockers.join(' '), /draft.*conflicts.*unresolved.*pending.*human approvals/);
  assert.deepEqual(data.writes, []);
});

test('unknown checks and denied checks do not enable merge', async () => {
  assert(checkBlockers({something: 'new'}).length);
  assert(checkBlockers({values: [{name: 'new check', status: 'UNRECOGNIZED', blocking: false}]}).length);
  assert.deepEqual(checkBlockers({checks: [{name: 'Approval', status: 'FAILED', blocking: true}]}), ['Approval']);
  assert(checkBlockers({checks: [{name: 'Advisory', status: 'FAILED', blocking: false}]}).length);
  assert(checkBlockers({checks: [{name: 'Unavailable', status: 'UNKNOWN', blocking: false}]}).length);
  const {ctx, data} = fixture();
  data.denied = '/mergeability/checks';
  await assert.rejects(snapshot(ctx, {url}), /403/);
  assert.deepEqual(data.writes, []);
});

test('merge is a single write after rechecking exact commits and diff; it keeps the source branch', async () => {
  const {ctx, data} = fixture();
  const pr = await snapshot(ctx, {url});
  const input = {url, source: pr.source, destination: pr.destination, fingerprint: pr.fingerprint};
  const action = prModule.actions!.merge;
  const preview = await action.preview(ctx, input);
  assert.match(preview.summary, /staging/);
  data.pr.source.commit.hash = 'c'.repeat(12);
  data.full.source = 'c'.repeat(40);
  await assert.rejects(action.run(ctx, input, () => {}), /changed since the review/);
  data.pr.source.commit.hash = sha.slice(0, 12);
  data.full.source = sha;
  data.pr.destination.commit.hash = 'd'.repeat(12);
  data.full.destination = 'd'.repeat(40);
  await assert.rejects(action.run(ctx, input, () => {}), /changed since the review/);
  data.pr.destination.commit.hash = target.slice(0, 12);
  data.full.destination = target;
  data.diff += '\n+another line';
  await assert.rejects(action.run(ctx, input, () => {}), /changed since the review/);
  data.diff = diff;
  data.statuses = [{state: 'FAILED'}];
  await assert.rejects(action.run(ctx, input, () => {}), /Merge blocked/);
  assert.deepEqual(data.writes, []);
  data.statuses = [{state: 'SUCCESSFUL'}];
  const result = await action.run(ctx, input, () => {});
  assert.match(result!.text!, /Merged #123 into staging/);
  assert.deepEqual(data.writes, [{merge_strategy: 'merge_commit', close_source_branch: false, message: 'Merge PR #123: Fix redirect'}]);
  data.mergedState = 'PENDING';
  await assert.rejects(action.run(ctx, input, () => {}), /not confirmed MERGED/);
  assert.equal(data.writes.length, 2, 'an uncertain merge is not retried');
});

