import {defineModule, type ModuleContext} from '@agentmuster/module-sdk';

// A module is one default export: actions you run from Muster with a preview first, tools the agent may call,
// Inbox feeds, and providers. Copy this folder into packages/, rename it, and change what you need.

async function repos(ctx: ModuleContext, limit = 5) {
  // ctx.fetch only reaches the hosts listed in the manifest's network list.
  const response = await ctx.fetch(`https://api.github.com/users/${encodeURIComponent(ctx.settings.owner)}/repos?per_page=${limit}`);
  if (!response.ok) throw new Error(`GitHub returned ${response.status}. Check the user name in the module's settings.`);
  return (await response.json()) as {name: string; description: string | null}[];
}

export default defineModule({
  tools: {
    async hello_repos(ctx, input) {
      const list = await repos(ctx, Math.min(20, Math.max(1, Number(input.limit) || 5)));
      return list.map(repo => `- ${repo.name}${repo.description ? `: ${repo.description}` : ''}`).join('\n') || 'No public repositories.';
    },
  },
  actions: {
    greet: {
      fields: () => [{key: 'name', label: 'Who to greet', type: 'string', required: true}],
      // A preview must not change anything. Muster shows it and asks the owner to confirm.
      preview: (_ctx, input) => ({summary: `Say hello to ${input.name}`, details: ['Nothing leaves this desktop.']}),
      async run(_ctx, input, progress) {
        progress({text: 'Thinking of something to say…'});
        return {text: `Hello, ${input.name}!`};
      },
    },
  },
});
