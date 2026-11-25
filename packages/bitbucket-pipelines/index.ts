import {parse} from 'yaml';
import {defineModule, type Field, type ModuleContext, type Progress} from '@agentmuster/module-sdk';

type Variable = {name: string; default?: string; description?: string; allowed?: string[]};
type Pipeline = {name: string; variables: Variable[]};

const api = (ctx: ModuleContext) => String(ctx.settings.apiBase || 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
const repoPath = (ctx: ModuleContext) =>
  `/repositories/${encodeURIComponent(ctx.settings.workspace)}/${encodeURIComponent(ctx.settings.repository)}`;
const webLink = (ctx: ModuleContext, build?: number) =>
  `https://bitbucket.org/${ctx.settings.workspace}/${ctx.settings.repository}/pipelines${build ? '/results/' + build : ''}`;

/** Calls the Bitbucket API with the configured token, and explains the common failures. */
async function bitbucket(ctx: ModuleContext, route: string, init: RequestInit = {}) {
  const token = ctx.secret('token');
  if (!token) throw new Error('Add an API token in Settings → Modules.');
  const auth = ctx.settings.username
    ? 'Basic ' + Buffer.from(`${ctx.settings.username}:${token}`).toString('base64')
    : 'Bearer ' + token;
  const response = await ctx.fetch(api(ctx) + route, {
    ...init,
    headers: {authorization: auth, accept: 'application/json', ...(init.body ? {'content-type': 'application/json'} : {}), ...init.headers},
  });
  if (response.ok) return response;
  let message = '';
  try {
    const body: any = await response.json();
    message = body?.error?.message || body?.error?.detail || '';
  } catch {
    // Not JSON.
  }
  if (response.status === 401) throw new Error('Bitbucket rejected the token. Check the account email and API token.');
  if (response.status === 403) {
    throw new Error(`Bitbucket refused access${message ? ` (${message})` : ''}. The token needs read:repository, read:pipeline and write:pipeline.`);
  }
  if (response.status === 404) throw new Error(`Not found on Bitbucket: check the workspace, repository and branch.${message ? ' ' + message : ''}`);
  throw new Error(`Bitbucket answered ${response.status}${message ? ': ' + message : ''}`);
}

/** The custom pipelines in bitbucket-pipelines.yml, with their variables. */
async function customPipelines(ctx: ModuleContext, branch: string): Promise<Pipeline[]> {
  const response = await bitbucket(ctx, `${repoPath(ctx)}/src/${encodeURIComponent(branch)}/bitbucket-pipelines.yml`, {
    headers: {accept: 'text/plain'},
  });
  const config = parse(await response.text(), {maxAliasCount: 1000}) ?? {};
  const custom = config?.pipelines?.custom ?? {};
  const offered = String(ctx.settings.pipelines || '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  return Object.entries<any>(custom)
    .filter(([name]) => !offered.length || offered.includes(name))
    .map(([name, steps]) => {
      const declared = (Array.isArray(steps) ? steps : []).find((step: any) => Array.isArray(step?.variables))?.variables ?? [];
      return {
        name,
        variables: declared
          .filter((v: any) => typeof v?.name === 'string')
          .map((v: any) => ({
            name: v.name,
            default: v.default === undefined || v.default === null ? undefined : String(v.default),
            description: typeof v.description === 'string' ? v.description : undefined,
            allowed: Array.isArray(v['allowed-values']) ? v['allowed-values'].map(String) : undefined,
          })),
      };
    });
}

const variableKey = (pipeline: string, name: string) => `var:${pipeline}:${name}`;

/** "pipeline = URL" lines from the settings. */
function healthUrls(ctx: ModuleContext) {
  const urls = new Map<string, string>();
  for (const line of String(ctx.settings.healthUrls || '').split('\n')) {
    const match = line.match(/^\s*([^=\s][^=]*?)\s*=\s*(https?:\/\/\S+)\s*$/);
    if (match) urls.set(match[1], match[2]);
  }
  return urls;
}

const ago = (iso?: string) => {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

const outcome = (state: any) => state?.result?.name || state?.stage?.name || state?.name || 'unknown';

function chosen(input: Record<string, any>, ctx: ModuleContext) {
  const pipeline = String(input.pipeline || '');
  const branch = String(input.branch || ctx.settings.branch || 'main');
  if (!pipeline) throw new Error('Choose a pipeline.');
  if (!/^[\w./-]{1,200}$/.test(branch)) throw new Error('That branch name is not valid.');
  return {pipeline, branch};
}

function variablesFor(pipeline: Pipeline, input: Record<string, any>) {
  return pipeline.variables.map(variable => {
    const value = input[variableKey(pipeline.name, variable.name)];
    return {key: variable.name, value: value === undefined || value === null ? (variable.default ?? '') : String(value)};
  });
}

export default defineModule({
  actions: {
    'run-pipeline': {
      async fields(ctx): Promise<Field[]> {
        const branch = String(ctx.settings.branch || 'main');
        const pipelines = await customPipelines(ctx, branch);
        if (!pipelines.length) throw new Error(`No custom pipelines found in bitbucket-pipelines.yml on ${branch}.`);
        const fields: Field[] = [
          {
            key: 'pipeline',
            label: 'Pipeline',
            type: 'select',
            required: true,
            options: pipelines.map(p => ({value: p.name, label: 'custom: ' + p.name})),
          },
          {key: 'branch', label: 'Branch', type: 'string', default: branch, description: 'The branch whose pipeline definition runs.'},
        ];
        for (const pipeline of pipelines) {
          for (const variable of pipeline.variables) {
            fields.push({
              key: variableKey(pipeline.name, variable.name),
              label: variable.name,
              type: variable.allowed ? 'select' : /note|message|description/i.test(variable.name) ? 'text' : 'string',
              description: variable.description,
              default: variable.default ?? '',
              options: variable.allowed?.map(value => ({value})),
              showWhen: {pipeline: [pipeline.name]},
            });
          }
        }
        return fields;
      },

      async preview(ctx, input) {
        const {pipeline: name, branch} = chosen(input, ctx);
        const pipelines = await customPipelines(ctx, branch);
        const pipeline = pipelines.find(p => p.name === name);
        if (!pipeline) throw new Error(`There is no custom pipeline "${name}" on ${branch}.`);
        const offset = Number(ctx.settings.releaseOffset) || 0;
        const release = (build: number) => (offset ? ` (release ${build + offset})` : '');

        const recent: any = await (await bitbucket(ctx, `${repoPath(ctx)}/pipelines/?sort=-created_on&pagelen=50`)).json();
        const runs: any[] = recent?.values ?? [];
        const newest = Math.max(0, ...runs.map(run => Number(run.build_number) || 0));
        const sameKind = runs.filter(run => run.target?.selector?.pattern === name);
        const last = sameKind.find(run => run.state?.name === 'COMPLETED') ?? sameKind[0];
        const running = sameKind.filter(run => run.state?.name !== 'COMPLETED');

        const details = [`${ctx.settings.workspace}/${ctx.settings.repository}, branch ${branch}`];
        const health = healthUrls(ctx).get(name);
        if (health) {
          try {
            const response = await ctx.fetch(health, {headers: {'cache-control': 'no-cache'}});
            const build = response.headers.get('current-build-version');
            const web = response.headers.get('current-web-build-version');
            details.push(build ? `Serving now: build ${build}${web ? `, web ${web}` : ''}` : `Serving now: ${health} gave no build number`);
          } catch (error: any) {
            details.push(`Serving now: could not read ${health} (${error.message})`);
          }
        }
        if (last) {
          const who = last.creator?.display_name ? `, by ${last.creator.display_name}` : '';
          details.push(`Last ${name}: #${last.build_number}${release(last.build_number)}, ${outcome(last.state).toLowerCase()}, ${ago(last.created_on)}${who}`);
        }
        details.push(`This run: about #${newest + 1}${release(newest + 1)}`);
        for (const variable of variablesFor(pipeline, input)) details.push(`${variable.key}: ${variable.value || '(empty)'}`);
        if (running.length) {
          details.push(`Already running: ${running.map(run => '#' + run.build_number).join(', ')}. This run waits for the earlier deploy.`);
        }
        return {
          summary: `Run custom: ${name} on ${branch}`,
          details,
          danger: /prod/i.test(name),
          confirmLabel: `Run ${name}`,
          link: webLink(ctx),
        };
      },

      async run(ctx, input, progress) {
        const {pipeline: name, branch} = chosen(input, ctx);
        const pipeline = (await customPipelines(ctx, branch)).find(p => p.name === name);
        if (!pipeline) throw new Error(`There is no custom pipeline "${name}" on ${branch}.`);
        const variables = variablesFor(pipeline, input).filter(variable => variable.value !== '');
        const started: any = await (
          await bitbucket(ctx, `${repoPath(ctx)}/pipelines/`, {
            method: 'POST',
            body: JSON.stringify({
              target: {type: 'pipeline_ref_target', ref_type: 'branch', ref_name: branch, selector: {type: 'custom', pattern: name}},
              ...(variables.length ? {variables} : {}),
            }),
          })
        ).json();
        const build = Number(started.build_number);
        const link = webLink(ctx, build);
        const offset = Number(ctx.settings.releaseOffset) || 0;
        const label = `Pipeline #${build}${offset ? ` (release ${build + offset})` : ''}`;
        progress({status: 'running', text: `${label} started`, link});

        const uuid = encodeURIComponent(started.uuid);
        let last: Progress = {status: 'running', text: `${label} started`, link};
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ctx.settings.pollSeconds) || 10) * 1000));
          let state: any;
          let steps: any[] = [];
          try {
            state = (await (await bitbucket(ctx, `${repoPath(ctx)}/pipelines/${uuid}`)).json()).state;
            steps = (await (await bitbucket(ctx, `${repoPath(ctx)}/pipelines/${uuid}/steps/?pagelen=100`)).json()).values ?? [];
          } catch (error: any) {
            // A brief API failure should not end a long deploy; keep watching.
            progress({...last, text: `${label}: still running (status check failed: ${error.message})`});
            continue;
          }
          last = {
            status: state?.name === 'COMPLETED' ? 'completed' : 'running',
            text: `${label}: ${outcome(state).toLowerCase().replace(/_/g, ' ')}`,
            link,
            steps: steps.map(step => ({name: String(step.name ?? 'step'), state: outcome(step.state).toLowerCase().replace(/_/g, ' ')})),
          };
          progress(last);
          if (state?.name === 'COMPLETED') {
            if (state?.result?.name !== 'SUCCESSFUL') throw new Error(`${label} ${outcome(state).toLowerCase()}. ${link}`);
            return last;
          }
        }
      },
    },
  },
});
