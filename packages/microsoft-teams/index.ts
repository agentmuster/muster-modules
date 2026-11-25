import {defineModule, type FeedItem, type ModuleContext} from '@agentmuster/module-sdk';

// Finds Teams messages meant for the owner through Microsoft Graph, called via the Composio CLI.
// Chats come from /me/chats ordered by latest message, so only chats with something new are read.
// Channels are read through one Graph $batch per 20 channels.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TEAMS_REFRESH_MS = 6 * 60 * 60_000;

type Me = {id: string; name: string};
type ChannelRef = {teamId: string; team: string; channelId: string; channel: string};
type State = {
  me?: Me;
  /** Start of the previous check: new conversations are read from here. */
  since?: string;
  chats?: Record<string, string>;
  channels?: Record<string, string>;
  teams?: {at: number; list: ChannelRef[]};
};

async function graph(ctx: ModuleContext, route: string, body?: unknown) {
  if (!ctx.composio) throw new Error('This module needs the composio connector.');
  const data = await ctx.composio(route.startsWith('http') ? route : GRAPH + route, {
    toolkit: 'microsoft_teams',
    method: body === undefined ? 'GET' : 'POST',
    body,
  });
  if (data?.error) throw new Error(`Microsoft Graph: ${data.error.message ?? data.error.code ?? 'request failed'}`);
  return data;
}

/** GETs many Graph routes with $batch, 20 at a time. Failed entries come back as undefined. */
async function batch(ctx: ModuleContext, routes: string[]) {
  const results: any[] = new Array(routes.length);
  for (let start = 0; start < routes.length; start += 20) {
    const chunk = routes.slice(start, start + 20);
    const data = await graph(ctx, '/$batch', {requests: chunk.map((url, i) => ({id: String(start + i), method: 'GET', url}))});
    for (const response of data?.responses ?? []) {
      if (response.status === 200) results[Number(response.id)] = response.body;
      else ctx.log(`Graph batch entry ${response.id} failed with ${response.status}`);
    }
  }
  return results;
}

/** Teams message HTML to plain text: mentions as @Name, emoji from their alt text, line breaks kept. */
export function htmlToText(html: string) {
  return String(html ?? '')
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<at\b[^>]*>(.*?)<\/at>/gi, '@$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const after = (time: string | undefined, than: string) => !!time && Date.parse(time) > Date.parse(than);
const latest = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
const authorOf = (message: any) => message?.from?.user?.displayName ?? message?.from?.application?.displayName ?? 'Someone';
const fromMe = (message: any, me: Me) => message?.from?.user?.id === me.id;
const mentionsMe = (message: any, me: Me) => (message?.mentions ?? []).some((m: any) => m?.mentioned?.user?.id === me.id);
const realMessage = (message: any) => message?.messageType === 'message' && !message.deletedDateTime;

/** The visible text of an adaptive card (posts from Workflows, bots and connectors), from its TextBlocks and facts. */
export function cardText(content: unknown) {
  let card: any = content;
  if (typeof content === 'string') {
    try {
      card = JSON.parse(content);
    } catch {
      return '';
    }
  }
  const out: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object' || out.length > 60) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if ((node.type === 'TextBlock' || node.type === 'TextRun') && typeof node.text === 'string') out.push(node.text);
    if (node.type === 'Fact' || (typeof node.title === 'string' && typeof node.value === 'string')) out.push(`${node.title}: ${node.value}`);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(card);
  return out.join('\n').trim();
}

function textOf(message: any) {
  const text = htmlToText(message?.body?.content ?? '').replace(/<attachment[^>]*><\/attachment>/gi, '').trim();
  const cards = (message?.attachments ?? [])
    .filter((a: any) => String(a?.contentType ?? '').includes('card'))
    .map((a: any) => cardText(a.content))
    .filter(Boolean);
  const combined = [text, ...cards].filter(Boolean).join('\n');
  if (combined) return combined;
  const names = (message?.attachments ?? []).map((a: any) => a?.name).filter(Boolean);
  return names.length ? `[attachment: ${names.join(', ')}]` : '[no text]';
}

/** The last few messages before this one, as "Name: text" lines, for context when a session starts. */
const contextOf = (earlier: any[]) =>
  earlier
    .slice(-4)
    .map(message => `${authorOf(message)}: ${textOf(message).slice(0, 600)}`)
    .join('\n') || undefined;

/** Trims a cursor map to the most recent entries so the saved state stays small. */
function trimCursors(map: Record<string, string>, keep = 400) {
  const entries = Object.entries(map).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  return Object.fromEntries(entries.slice(0, keep));
}

async function chatItems(ctx: ModuleContext, state: State, me: Me, floor: string) {
  const items: FeedItem[] = [];
  const readBefore: Record<string, string> = {};
  const cursors = {...(state.chats ?? {})};
  const listing = await graph(ctx, '/me/chats?$top=50&$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc');
  const chats: any[] = listing?.value ?? [];
  const due: any[] = [];
  for (const chat of chats) {
    const read = chat?.viewpoint?.lastMessageReadDateTime;
    if (typeof read === 'string') readBefore[chat.id] = read;
    if (after(chat?.lastMessagePreview?.createdDateTime, cursors[chat.id] ?? floor)) due.push(chat);
  }
  const pages = await batch(ctx, due.map(chat => `/chats/${encodeURIComponent(chat.id)}/messages?$top=30`));
  due.forEach((chat, index) => {
    const page = pages[index];
    if (!page) return;
    const seen = cursors[chat.id] ?? floor;
    const messages = (page.value ?? []).filter(realMessage).sort((a: any, b: any) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
    const everyGroupMessage = ctx.settings.groupChats === 'all';
    messages.forEach((message: any, at: number) => {
      if (!after(message.createdDateTime, seen) || fromMe(message, me)) return;
      const direct = chat.chatType === 'oneOnOne';
      if (!direct && !mentionsMe(message, me) && !(everyGroupMessage && chat.chatType === 'group')) return;
      const author = authorOf(message);
      const topic = typeof chat.topic === 'string' && chat.topic.trim() ? chat.topic.trim() : '';
      items.push({
        id: message.id,
        group: chat.id,
        title: direct ? author : topic || (chat.chatType === 'meeting' ? 'Meeting chat' : 'Group chat'),
        place: direct ? 'Direct message' : chat.chatType === 'meeting' ? 'Meeting chat' : 'Group chat',
        author,
        text: textOf(message),
        time: message.createdDateTime,
        url: typeof chat.webUrl === 'string' ? chat.webUrl : undefined,
        context: contextOf(messages.slice(0, at)),
        read: typeof readBefore[chat.id] === 'string' && !after(message.createdDateTime, readBefore[chat.id]),
      });
    });
    cursors[chat.id] = latest(seen, messages.at(-1)?.createdDateTime) ?? seen;
  });
  return {items, readBefore, cursors: trimCursors(cursors)};
}

async function channelList(ctx: ModuleContext, state: State): Promise<ChannelRef[]> {
  if (state.teams && Date.now() - state.teams.at < TEAMS_REFRESH_MS) return state.teams.list;
  const teams: any[] = (await graph(ctx, '/me/joinedTeams?$select=id,displayName'))?.value ?? [];
  const pages = await batch(ctx, teams.map(team => `/teams/${team.id}/channels?$select=id,displayName`));
  const list: ChannelRef[] = [];
  teams.forEach((team, index) => {
    for (const channel of pages[index]?.value ?? []) {
      list.push({teamId: team.id, team: team.displayName, channelId: channel.id, channel: channel.displayName});
    }
  });
  state.teams = {at: Date.now(), list};
  return list;
}

async function channelItems(ctx: ModuleContext, state: State, me: Me, floor: string) {
  const items: FeedItem[] = [];
  const cursors = {...(state.channels ?? {})};
  if (ctx.settings.channels === 'off') return {items, cursors};
  const repliesToMe = ctx.settings.channels !== 'mentions';
  const channels = await channelList(ctx, state);
  const pages = await batch(
    ctx,
    channels.map(c => `/teams/${c.teamId}/channels/${encodeURIComponent(c.channelId)}/messages?$top=20&$expand=replies`),
  );
  channels.forEach((c, index) => {
    const page = pages[index];
    if (!page) return;
    const key = `${c.teamId}|${c.channelId}`;
    const seen = cursors[key] ?? floor;
    let newest = seen;
    for (const root of page.value ?? []) {
      if (!realMessage(root)) continue;
      const replies = (root.replies ?? []).filter(realMessage).sort((a: any, b: any) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
      const thread = [root, ...replies];
      thread.forEach((message: any, at: number) => {
        newest = latest(newest, message.createdDateTime) ?? newest;
        if (!after(message.createdDateTime, seen) || fromMe(message, me)) return;
        const isReply = at > 0;
        if (!mentionsMe(message, me) && !(isReply && repliesToMe && fromMe(root, me))) return;
        const subject = typeof root.subject === 'string' && root.subject.trim() ? root.subject.trim() : textOf(root).split('\n')[0].slice(0, 80);
        items.push({
          id: message.id,
          group: key,
          title: subject || c.channel,
          place: `${c.team} › ${c.channel}`,
          author: authorOf(message),
          text: textOf(message),
          time: message.createdDateTime,
          url: typeof message.webUrl === 'string' ? message.webUrl : typeof root.webUrl === 'string' ? root.webUrl : undefined,
          context: isReply ? contextOf(thread.slice(0, at)) : undefined,
        });
      });
    }
    cursors[key] = newest;
  });
  return {items, cursors: trimCursors(cursors)};
}

// Agent tools: plain text for the model, one message per block with the ids needed to read further.

const stamp = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') + 'Z' : '');
const clamp = (value: unknown, low: number, high: number, fallback: number) =>
  Number.isFinite(Number(value)) ? Math.min(high, Math.max(low, Math.round(Number(value)))) : fallback;
const messageLine = (message: any) => `${stamp(message.createdDateTime)} ${authorOf(message)}: ${textOf(message)}`;

async function searchMessages(ctx: ModuleContext, input: Record<string, any>) {
  const query = String(input.query ?? '').trim();
  if (!query) throw new Error('query is required.');
  const size = clamp(input.limit, 1, 25, 10);
  const data = await graph(ctx, '/search/query', {requests: [{entityTypes: ['chatMessage'], query: {queryString: query}, from: 0, size}]});
  const container = data?.value?.[0]?.hitsContainers?.[0];
  const hits: any[] = container?.hits ?? [];
  if (!hits.length) return `No Teams messages match "${query}".`;
  const blocks = hits.map((hit, index) => {
    const r = hit.resource ?? {};
    const snippet = htmlToText(String(hit.summary ?? '').replace(/<\/?c0>/g, '')).replace(/\s+/g, ' ');
    const where = r.channelIdentity?.channelId
      ? `channel post: team_id=${r.channelIdentity.teamId} channel_id=${r.channelIdentity.channelId} message_id=${r.id}`
      : `chat: chat_id=${r.chatId} message_id=${r.id}`;
    return [`${index + 1}. ${stamp(r.createdDateTime)} ${authorOf(r)}${r.subject ? ` | ${r.subject}` : ''}`, `   ${snippet}`, `   ${where}`, r.webLink ? `   link: ${r.webLink}` : '']
      .filter(Boolean)
      .join('\n');
  });
  return `${container?.total ?? hits.length} matches for "${query}"; showing ${hits.length}:\n\n${blocks.join('\n\n')}`;
}

async function recentChats(ctx: ModuleContext) {
  const data = await graph(ctx, '/me/chats?$top=50&$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc');
  const me = await graph(ctx, '/me?$select=id');
  return {me: me?.id as string, chats: (data?.value ?? []) as any[]};
}

const chatName = (chat: any, me: string) => {
  const others = (chat.members ?? []).filter((m: any) => m.userId !== me).map((m: any) => m.displayName).filter(Boolean);
  const topic = typeof chat.topic === 'string' && chat.topic.trim() ? chat.topic.trim() : '';
  return {topic, others};
};

async function listChats(ctx: ModuleContext, input: Record<string, any>) {
  const filter = String(input.filter ?? '').trim().toLowerCase();
  const {me, chats} = await recentChats(ctx);
  const lines = chats
    .map(chat => ({chat, ...chatName(chat, me)}))
    .filter(({topic, others}) => !filter || [topic, ...others].some(name => name.toLowerCase().includes(filter)))
    .slice(0, 30)
    .map(({chat, topic, others}) => {
      const preview = chat.lastMessagePreview;
      const last = preview ? `${stamp(preview.createdDateTime)} ${preview.from?.user?.displayName ?? 'someone'}: ${htmlToText(preview.body?.content ?? '').replace(/\s+/g, ' ').slice(0, 160)}` : 'no messages';
      const members = others.length > 6 ? `${others.slice(0, 6).join(', ')} and ${others.length - 6} more` : others.join(', ');
      return `- ${chat.chatType}${topic ? ` "${topic}"` : ''} with ${members || 'nobody else'}\n  chat_id=${chat.id}\n  latest: ${last}`;
    });
  return lines.length ? lines.join('\n') : `No recent chats${filter ? ` matching "${input.filter}"` : ''}.`;
}

async function readChat(ctx: ModuleContext, input: Record<string, any>) {
  let chatId = String(input.chat_id ?? '').trim();
  let label = chatId;
  if (!chatId) {
    const person = String(input.person ?? '').trim().toLowerCase();
    if (!person) throw new Error('Give chat_id or person.');
    const {me, chats} = await recentChats(ctx);
    const named = chats.map(chat => ({chat, ...chatName(chat, me)})).filter(({others}) => others.some((name: string) => name.toLowerCase().includes(person)));
    const pick = named.find(({chat}) => chat.chatType === 'oneOnOne') ?? named[0];
    if (!pick) return `No recent chat with "${input.person}". Try teams_search with their name.`;
    chatId = pick.chat.id;
    label = `${pick.chat.chatType} with ${pick.others.join(', ')}`;
  }
  const limit = clamp(input.limit, 1, 50, 25);
  const data = await graph(ctx, `/chats/${encodeURIComponent(chatId)}/messages?$top=${limit}`);
  const messages = (data?.value ?? []).filter(realMessage).sort((a: any, b: any) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
  if (!messages.length) return `No messages in ${label}.`;
  return `Last ${messages.length} messages in ${label} (chat_id=${chatId}), oldest first:\n\n${messages.map(messageLine).join('\n\n')}`;
}

/** Team, channel and root message ids from a Teams message link, when they are in it. */
export function parseMessageLink(link: string) {
  try {
    const url = new URL(link);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const at = parts.indexOf('message');
    if (at < 0) return undefined;
    const container = parts[at + 1];
    const message = url.searchParams.get('parentMessageId') || parts[at + 2];
    const team = url.searchParams.get('groupId') ?? undefined;
    return {container, message, team};
  } catch {
    return undefined;
  }
}

async function readThread(ctx: ModuleContext, input: Record<string, any>) {
  let team = String(input.team_id ?? '').trim();
  let channel = String(input.channel_id ?? '').trim();
  let message = String(input.message_id ?? '').trim();
  if (input.link) {
    const parsed = parseMessageLink(String(input.link));
    if (!parsed) throw new Error('That is not a Teams message link.');
    if (!parsed.team) return readChat(ctx, {chat_id: parsed.container, limit: 30});
    ({team, container: channel, message} = {team: parsed.team, container: parsed.container, message: parsed.message});
  }
  if (!team || !channel || !message) throw new Error('Give link, or team_id, channel_id and message_id.');
  const base = `/teams/${encodeURIComponent(team)}/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(message)}`;
  const [root, replies] = await batch(ctx, [base, `${base}/replies?$top=50`]);
  if (!root) throw new Error('Could not read that channel post. It may be in a channel the owner cannot read.');
  const list = (replies?.value ?? []).filter(realMessage).sort((a: any, b: any) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
  const head = `${root.subject ? `Subject: ${root.subject}\n` : ''}${messageLine(root)}`;
  return `${head}${root.webUrl ? `\nlink: ${root.webUrl}` : ''}\n\n${list.length} replies:\n\n${list.map(messageLine).join('\n\n') || '(none)'}`;
}

export default defineModule({
  tools: {
    teams_search: searchMessages,
    teams_recent_chats: listChats,
    teams_read_chat: readChat,
    teams_read_thread: readThread,
  },
  feeds: {
    inbox: {
      async list(ctx, previous) {
        const state: State = previous && typeof previous === 'object' ? {...previous} : {};
        const started = new Date().toISOString();
        const days = Number(ctx.settings.lookbackDays) > 0 ? Number(ctx.settings.lookbackDays) : 2;
        const floor = state.since ?? new Date(Date.now() - days * 86_400_000).toISOString();
        if (!state.me) {
          const me = await graph(ctx, '/me?$select=id,displayName');
          state.me = {id: me.id, name: me.displayName};
        }
        const chats = await chatItems(ctx, state, state.me, floor);
        const channels = await channelItems(ctx, state, state.me, floor);
        return {
          items: [...chats.items, ...channels.items],
          readBefore: chats.readBefore,
          state: {...state, since: started, chats: chats.cursors, channels: channels.cursors},
        };
      },
    },
  },
});
