import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestContext} from '@agentmuster/module-sdk/testing';
import hello from '../index.ts';

test('the preview says what will happen, and the run does it', async () => {
  const ctx = createTestContext();
  const preview = await hello.actions!.greet.preview(ctx, {name: 'Sam'});
  assert.equal(preview.summary, 'Say hello to Sam');
  const result = await hello.actions!.greet.run(ctx, {name: 'Sam'}, () => {});
  assert.equal(result!.text, 'Hello, Sam!');
});

test('the agent tool lists repositories, and only contacts GitHub', async () => {
  const ctx = createTestContext({
    settings: {owner: 'octo'},
    network: ['api.github.com'],
    fetch: () => Response.json([{name: 'hello', description: 'Says hello'}]),
  });
  assert.equal(await hello.tools!.hello_repos(ctx, {}), '- hello: Says hello');
  assert.equal(ctx.requests[0].url, 'https://api.github.com/users/octo/repos?per_page=5');
});
