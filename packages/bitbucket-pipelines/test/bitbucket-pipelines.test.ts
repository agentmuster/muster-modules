import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createTestContext} from '@agentmuster/module-sdk/testing';
import pipelines from '../index.ts';

const API = 'https://api.bitbucket.org/2.0/repositories/acme/deploys';
const AUTH = 'Basic ' + Buffer.from('dev@acme.test:tok-123').toString('base64');

/** A fake Bitbucket API and environment health endpoint. */
function context() {
  let checks = 0;
  const posts: any[] = [];
  const ctx = createTestContext({
    settings: {
      workspace: 'acme',
      repository: 'deploys',
      username: 'dev@acme.test',
      branch: 'main',
      healthUrls: 'deploy-production = https://health.acme.test/health',
      releaseOffset: 2200,
      pollSeconds: 1,
    },
    secrets: {token: 'tok-123'},
    network: ['api.bitbucket.org', 'health.acme.test'],
    fetch(url, init) {
      const headers = new Headers(init?.headers);
      if (url === 'https://health.acme.test/health') {
        return new Response('ok', {headers: {'current-build-version': '2611', 'current-web-build-version': '2609'}});
      }
      if (headers.get('authorization') !== AUTH) return new Response('{}', {status: 401});
      if (url === `${API}/src/main/bitbucket-pipelines.yml`) return new Response(readFileSync(path.join(import.meta.dirname, 'bitbucket-pipelines.yml')));
      if (url.startsWith(`${API}/pipelines/?sort=-created_on`)) {
        return Response.json({values: [
          {build_number: 411, target: {selector: {pattern: 'deploy-staging'}}, state: {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}, created_on: new Date().toISOString(), creator: {display_name: 'Dev'}},
          {build_number: 409, target: {selector: {pattern: 'deploy-production'}}, state: {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}, created_on: new Date(Date.now() - 3 * 3600_000).toISOString(), creator: {display_name: 'Alex'}},
        ]});
      }
      if (init?.method === 'POST' && url === `${API}/pipelines/`) {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({build_number: 412, uuid: '{p-412}'}, {status: 201});
      }
      if (url === `${API}/pipelines/${encodeURIComponent('{p-412}')}`) {
        checks++;
        return Response.json({state: checks < 2 ? {name: 'IN_PROGRESS', stage: {name: 'RUNNING'}} : {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}});
      }
      if (url.startsWith(`${API}/pipelines/${encodeURIComponent('{p-412}')}/steps/`)) {
        return Response.json({values: [
          {name: 'build', state: {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}},
          {name: 'deploy', state: checks < 2 ? {name: 'IN_PROGRESS'} : {name: 'COMPLETED', result: {name: 'SUCCESSFUL'}}},
        ]});
      }
      return new Response('{}', {status: 404});
    },
  });
  return {ctx, posts};
}

const action = pipelines.actions!['run-pipeline'];

test('the form lists the pipelines and their variables from bitbucket-pipelines.yml', async () => {
  const {ctx} = context();
  const fields = await action.fields!(ctx);
  assert.deepEqual(fields.find(f => f.key === 'pipeline')!.options!.map(o => o.value), ['deploy-production', 'deploy-staging', 'rebuild-cache']);
  const appBranch = fields.find(f => f.key === 'var:deploy-staging:APP_BRANCH')!;
  assert.equal(appBranch.default, 'staging');
  assert.deepEqual(appBranch.showWhen, {pipeline: ['deploy-staging']});
  assert.equal(fields.find(f => f.key === 'var:deploy-production:RELEASE_NOTE')!.type, 'text');
});

test('the preview shows what is live and what will run, and changes nothing', async () => {
  const {ctx, posts} = context();
  const preview = await action.preview(ctx, {pipeline: 'deploy-production', branch: 'main', 'var:deploy-production:RELEASE_NOTE': 'List query on direct SQL'});
  assert.equal(preview.summary, 'Run custom: deploy-production on main');
  assert.equal(preview.danger, true);
  assert(preview.details!.includes('Serving now: build 2611, web 2609'), preview.details!.join('\n'));
  assert(preview.details!.some(d => /^Last deploy-production: #409 \(release 2609\), successful, 3 h ago, by Alex$/.test(d)), preview.details!.join('\n'));
  assert(preview.details!.includes('This run: about #412 (release 2612)'));
  assert(preview.details!.includes('RELEASE_NOTE: List query on direct SQL'));
  assert.equal(posts.length, 0);
});

test('running triggers the pipeline once and follows it to the end', async () => {
  const {ctx, posts} = context();
  const updates: any[] = [];
  const result = await action.run(ctx, {pipeline: 'deploy-production', branch: 'main', 'var:deploy-production:RELEASE_NOTE': 'List query on direct SQL'}, p => updates.push(p));
  assert.deepEqual(posts, [{
    target: {type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main', selector: {type: 'custom', pattern: 'deploy-production'}},
    variables: [{key: 'RELEASE_NOTE', value: 'List query on direct SQL'}],
  }]);
  assert.equal(result!.text, 'Pipeline #412 (release 2612): successful');
  assert.deepEqual(result!.steps, [{name: 'build', state: 'successful'}, {name: 'deploy', state: 'successful'}]);
  assert.equal(result!.link, 'https://bitbucket.org/acme/deploys/pipelines/results/412');
  assert(updates.length > 0, 'progress was reported');
  assert(!JSON.stringify(ctx.logs).includes('tok-123'), 'the token is never logged');
});

test('a wrong token explains what to fix', async () => {
  const {ctx} = context();
  const wrong = {...ctx, secret: () => 'wrong'};
  await assert.rejects(async () => action.fields!(wrong), /401|token|scope/i);
});
