import {defineModule, prFingerprint, type ModuleContext, type PullRequestSnapshot} from '@agentmuster/module-sdk';

// Reviews and merges Bitbucket Cloud pull requests for Muster. Muster shows the PR's diff to the owner and pins their
// sign-off to the exact commits and diff; this module reads the PR and, after that sign-off, merges it.

export function parsePrUrl(value: unknown) {
  const url = new URL(String(value));
  const match = /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/pull-requests\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'bitbucket.org' || url.port || url.username || url.password || !match) {
    throw new Error('Give a Bitbucket Cloud PR URL, such as https://bitbucket.org/workspace/repo/pull-requests/123.');
  }
  const [, workspace, repo, id] = match;
  return {workspace, repo, id, url: `https://bitbucket.org/${workspace}/${repo}/pull-requests/${id}`};
}

const base = (ctx: ModuleContext) => String(ctx.settings.apiBase || 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
const routeFor = (url: unknown) => {
  const pr = parsePrUrl(url);
  return `/repositories/${pr.workspace}/${pr.repo}/pullrequests/${pr.id}`;
};

async function request(ctx: ModuleContext, route: string, init: RequestInit = {}) {
  const token = ctx.secret('token');
  if (!token) throw new Error('Configure the Bitbucket pull requests module first.');
  const endpoint = new URL(route.startsWith('http') ? route : base(ctx) + route);
  const api = new URL(base(ctx));
  if (endpoint.origin !== api.origin || !endpoint.pathname.startsWith(api.pathname + '/')) throw new Error('Unexpected Bitbucket API URL.');
  const auth = ctx.settings.username ? 'Basic ' + Buffer.from(`${ctx.settings.username}:${token}`).toString('base64') : 'Bearer ' + token;
  const response = await ctx.fetch(endpoint.href, { ...init, headers: {authorization: auth, accept: 'application/json', ...init.headers} });
  if (!response.ok) {
    // Do not relay an API error body, which can contain credentials or untrusted markup.
    throw new Error(`Bitbucket returned ${response.status}. Check access, token scopes and repository rules.`);
  }
  return response;
}
const json = async (ctx: ModuleContext, route: string) => (await request(ctx, route)).json();

async function pages(ctx: ModuleContext, route: string): Promise<any[]> {
  const values: any[] = [];
  for (let page = 0; page < 10; page++) {
    const data = await json(ctx, route);
    if (!Array.isArray(data.values)) throw new Error('Bitbucket returned an unexpected paginated result.');
    values.push(...data.values);
    if (!data.next) return values;
    route = data.next;
  }
  throw new Error('Too many check results to verify safely. Open the PR in Bitbucket.');
}

/** Unknown, pending and failed checks do not count as passing, even when Bitbucket treats them as advisory. */
export function checkBlockers(data: unknown): string[] {
  const checks: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.status === 'string' && typeof node.blocking === 'boolean') checks.push(node);
    for (const [key, value] of Object.entries(node)) if (key !== 'status') {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(data);
  if (!checks.length) return ['Bitbucket mergeability checks could not be verified.'];
  const passing = new Set(['PASS', 'PASSED', 'SUCCESS', 'SUCCESSFUL', 'SKIPPED', 'NOT_APPLICABLE']);
  return checks.filter(check => check.blocking || !passing.has(check.status.toUpperCase()))
    .map(check => String(check.description || check.name || check.key || 'Unverified merge check').slice(0, 250));
}

export async function snapshot(ctx: ModuleContext, input: Record<string, any>, withDiff = true): Promise<PullRequestSnapshot & {id: string; repository: string}> {
  const link = parsePrUrl(input.url);
  const route = routeFor(link.url);
  const pr = await json(ctx, route);
  const [statuses, tasks, conflicts, checks] = await Promise.all([
    pages(ctx, route + '/statuses?pagelen=100'),
    pages(ctx, route + '/tasks?pagelen=100'),
    pages(ctx, route + '/conflicts?pagelen=100'),
    json(ctx, route + '/mergeability/checks'),
  ]);
  // The PR object carries abbreviated hashes; the commit endpoint gives the full ones the review is pinned to.
  const shortSource = String(pr.source?.commit?.hash ?? '');
  const shortDestination = String(pr.destination?.commit?.hash ?? '');
  if (!/^[a-f0-9]{7,64}$/.test(shortSource) || !/^[a-f0-9]{7,64}$/.test(shortDestination)) throw new Error('Missing PR commit identities.');
  const repoRoute = `/repositories/${link.workspace}/${link.repo}`;
  const fullHash = async (short: string) => {
    const hash = String((await json(ctx, `${repoRoute}/commit/${short}`))?.hash ?? '');
    if (!/^[a-f0-9]{40,64}$/.test(hash) || !hash.startsWith(short)) throw new Error('Could not resolve the PR commits.');
    return hash;
  };
  const [source, destination] = await Promise.all([fullHash(shortSource), fullHash(shortDestination)]);
  const target = String(pr.destination?.branch?.name || '');
  const allowed = String(ctx.settings.allowedBranches || 'staging,main').split(',').map(value => value.trim()).filter(Boolean);
  const blockers = checkBlockers(checks);
  if (pr.state !== 'OPEN') blockers.push(`PR is ${pr.state}.`);
  if (pr.draft) blockers.push('PR is a draft.');
  if (pr.queued) blockers.push('PR is already in a merge queue.');
  if (!allowed.includes(target)) blockers.push(`Target ${target} is not in the module's allowed branches.`);
  if (conflicts.length) blockers.push(`${conflicts.length} merge conflicts.`);
  if (tasks.some(task => task.state !== 'RESOLVED')) blockers.push('There are unresolved PR tasks.');
  // A PR without builds can merge after the owner's review; failed or pending builds still block.
  if (statuses.some(status => status.state !== 'SUCCESSFUL')) blockers.push('Builds are failed, pending or not successful.');
  const participants = pr.participants || [];
  if (participants.some((p: any) => p.state === 'changes_requested')) blockers.push('A reviewer requested changes.');
  const approvals = new Set(participants.filter((p: any) => p.approved === true && p.user?.uuid && p.user.uuid !== pr.author?.uuid).map((p: any) => p.user.uuid)).size;
  const minimum = Number(ctx.settings.minApprovals ?? 0);
  if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('Minimum approvals must be a non-negative integer.');
  if (approvals < minimum) blockers.push(`Needs ${minimum} human approvals; has ${approvals}.`);
  let diff = '';
  if (withDiff) {
    diff = await (await request(ctx, route + '/diff', {headers: {accept: 'text/plain'}})).text();
    if (Buffer.byteLength(diff) > 5_000_000) throw new Error('This PR diff is over 5 MB. Review it in Bitbucket.');
    if (!diff.trim()) throw new Error('The PR has no reviewable text diff.');
  }
  // Detect a changed branch while the diff and checks were being fetched.
  const after = await json(ctx, route);
  if (after.source?.commit?.hash !== shortSource || after.destination?.commit?.hash !== shortDestination || after.state !== pr.state) {
    throw new Error('The PR changed while it was being checked. Refresh and try again.');
  }
  return {
    url: link.url, id: link.id, repository: `${link.workspace}/${link.repo}`, title: String(pr.title || ''),
    description: String(pr.description || '').slice(0, 12_000), state: String(pr.state), source, destination,
    sourceBranch: String(pr.source?.branch?.name || ''), target, approvals,
    statuses: statuses.map(s => ({name: s.name || s.key, state: s.state})), blockers, diff,
    fingerprint: prFingerprint(link.url, source, destination, diff),
  };
}

async function mergeCheck(ctx: ModuleContext, input: Record<string, any>) {
  const current = await snapshot(ctx, input);
  if (current.source !== input.source || current.destination !== input.destination || current.fingerprint !== input.fingerprint) {
    throw new Error('Source, target or diff changed since the review. Review the PR again.');
  }
  if (current.blockers.length) throw new Error('Merge blocked: ' + current.blockers.join(' '));
  return current;
}

export default defineModule({
  providers: {pullRequests: {snapshot: (ctx, input) => snapshot(ctx, input)}},
  tools: {bitbucket_pr_context: async (ctx, input) => JSON.stringify(await snapshot(ctx, input))},
  actions: {
    merge: {
      fields: () => [{key: 'url', label: 'PR URL', type: 'string', required: true}],
      async preview(ctx, input) {
        const pr = await mergeCheck(ctx, input);
        return {summary: `Merge ${pr.repository} #${pr.id} into ${pr.target}`, danger: true, confirmLabel: 'Merge this PR', link: pr.url,
          details: [pr.title, `${pr.sourceBranch} → ${pr.target}`, `Source ${pr.source}`, `Target ${pr.destination}`, 'You reviewed this exact diff; live checks passed.', `${pr.approvals} approvals in Bitbucket.`,
            'The source branch will not be deleted. Bitbucket applies its own merge rules again.',
            'Bitbucket does not provide an atomic expected-commit condition. Avoid concurrent pushes while confirming.']};
      },
      async run(ctx, input, progress) {
        const pr = await mergeCheck(ctx, input);
        progress({text: 'Checks passed. Asking Bitbucket to merge.'});
        const response = await request(ctx, routeFor(pr.url) + '/merge', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({merge_strategy: 'merge_commit', close_source_branch: false, message: `Merge PR #${pr.id}: ${pr.title}`.slice(0, 200)}),
        });
        const result = await response.json();
        if (result.state === 'MERGED') return {text: `Merged #${pr.id} into ${pr.target}.`, link: pr.url};
        // Never retry an uncertain write or pretend that an accepted asynchronous merge has finished.
        throw new Error('Bitbucket accepted the request but has not confirmed MERGED. Check the PR before trying anything else.');
      },
    },
  },
});
