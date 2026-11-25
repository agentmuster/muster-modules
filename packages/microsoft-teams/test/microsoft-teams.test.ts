import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestContext} from '@agentmuster/module-sdk/testing';
import teams, {cardText, htmlToText, parseMessageLink} from '../index.ts';

test('Teams message HTML becomes readable text', () => {
  assert.equal(
    htmlToText('<p>Hi <at id="0">Alex</at>,</p><p>can you check&nbsp;this? <img alt="👍" src="x"></p><ul><li>one</li><li>two &amp; three</li></ul>'),
    'Hi @Alex,\ncan you check this? 👍\n• one\n• two & three',
  );
});

test('message links and adaptive cards are read', () => {
  assert.deepEqual(
    parseMessageLink('https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1732?groupId=team-1&tenantId=t&parentMessageId=1700&createdTime=1'),
    {container: '19:abc@thread.tacv2', message: '1700', team: 'team-1'},
  );
  assert.equal(parseMessageLink('https://teams.microsoft.com/l/message/19:chat@unq.gbl.spaces/55')!.team, undefined);
  assert.equal(parseMessageLink('not a link'), undefined);
  assert.equal(
    cardText(JSON.stringify({type: 'AdaptiveCard', body: [{type: 'TextBlock', text: 'Production deploying'}, {type: 'FactSet', facts: [{title: 'Build', value: '2582'}]}]})),
    'Production deploying\nBuild: 2582',
  );
});

/** Fake Microsoft Graph answers, through the Composio connector. */
function graph() {
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const me = {id: 'me-1', displayName: 'Alex'};
  const message = (id: string, from: string, text: string, minutes: number, mentions: any[] = []) => ({
    id, messageType: 'message', createdDateTime: at(minutes), from: {user: {id: from, displayName: from === 'me-1' ? 'Alex' : 'Dana'}},
    body: {contentType: 'html', content: text}, mentions,
  });
  const chats = [
    {id: 'dm', chatType: 'oneOnOne', webUrl: 'https://teams.microsoft.com/l/chat/dm', lastMessagePreview: {createdDateTime: at(5)}, viewpoint: {lastMessageReadDateTime: at(60)}},
    {id: 'group', chatType: 'group', topic: 'Release planning', webUrl: 'https://teams.microsoft.com/l/chat/group', lastMessagePreview: {createdDateTime: at(3)}},
  ];
  const messages: Record<string, any[]> = {
    dm: [message('d1', 'dana', 'Can you look at the failed sync?', 5), message('d2', 'me-1', 'On it', 4)],
    group: [message('g1', 'dana', 'Lunch?', 4), message('g2', 'dana', '<at id="0">Alex</at> can we ship 2581 tonight?', 3, [{mentioned: {user: {id: 'me-1'}}}])],
  };
  return createTestContext({
    settings: {groupChats: 'mentions', channels: 'off', lookbackDays: 2},
    network: ['graph.microsoft.com'],
    composio(url, call) {
      const route = url.replace('https://graph.microsoft.com/v1.0', '');
      if (route.startsWith('/me?')) return me;
      if (route.startsWith('/me/chats')) return {value: chats};
      if (route === '/$batch') {
        return {responses: (call.body as any).requests.map((r: any) => {
          const id = decodeURIComponent(/^\/chats\/([^/]+)\/messages/.exec(r.url)![1]);
          return {id: r.id, status: 200, body: {value: messages[id]}};
        })};
      }
      throw new Error('Unexpected Graph call ' + route);
    },
  });
}

test('the Inbox feed keeps direct messages and @mentions from others, and skips the rest', async () => {
  const ctx = graph();
  const result = await teams.feeds!.inbox.list(ctx, null);
  const ids = result.items.map(item => item.id).sort();
  assert.deepEqual(ids, ['d1', 'g2'], 'my own reply and the unmentioned group message are left out');
  const dm = result.items.find(item => item.id === 'd1')!;
  assert.equal(dm.place, 'Direct message');
  assert.equal(dm.read, false);
  assert.equal(result.items.find(item => item.id === 'g2')!.text, '@Alex can we ship 2581 tonight?');
  assert(result.state.since, 'the next check starts from this one');
  const again = await teams.feeds!.inbox.list(ctx, result.state);
  assert.equal(again.items.length, 0, 'nothing is reported twice');
});

test('Graph is reached only through the Composio connector', async () => {
  const ctx = createTestContext({settings: {}});
  await assert.rejects(teams.feeds!.inbox.list(ctx, null), /composio/);
});
