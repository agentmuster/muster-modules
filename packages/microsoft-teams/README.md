# Microsoft Teams

Puts Teams messages meant for you in Muster's Inbox, and lets the agent search and read Teams while it works.

## Inbox

Every five minutes it checks:

- direct messages;
- @mentions of you in group and meeting chats (or every group message, if you choose);
- @mentions of you in channels, and replies to your posts.

It opens only chats with something new, and mirrors Teams' read state, so anything you've read in Teams shows as read in Muster. The first check looks back two days. Muster then groups the messages into requests with your default model.

## Agent tools

All read-only:

- `teams_search`: keywords, ticket numbers or people, across chats and channels;
- `teams_recent_chats`: your latest chats, optionally filtered by name;
- `teams_read_chat`: a chat's recent messages, by chat id or a person's name;
- `teams_read_thread`: a channel post and its replies, by ids or a Teams link.

Posts from Workflows and other apps are read from their adaptive cards.

## What it needs

The [Composio CLI](https://composio.dev) on the desktop, linked to your Microsoft account once with `composio link microsoft_teams`. Muster calls Microsoft Graph through it, so your Teams sign-in never passes through Muster. Reading channel messages needs the `ChannelMessage.Read.All` permission, which some organizations only grant with admin consent.
