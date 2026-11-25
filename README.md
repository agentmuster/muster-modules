# Muster modules

Modules connect [Muster](https://agentmuster.com) ([code](https://github.com/agentmuster/muster)) to other services. A module can add:

- **actions** you run from Muster's Actions panel, such as a deploy, always with a preview and your confirmation first;
- **Inbox feeds**, such as Teams messages meant for you, which Muster groups into requests;
- **agent tools** the agent can call while it works, such as searching Teams;
- **providers** for Muster features, such as reviewing and merging pull requests.

Each module is a folder with a `muster-module.json` manifest and an entry file, published as its own npm package. Muster will be able to browse this repo's `registry.json` and install modules from the app.

## Modules

| Module | What it does |
|---|---|
| [Bitbucket Pipelines](packages/bitbucket-pipelines) | Run custom pipelines, such as deploys, with a preview of what's live |
| [Bitbucket pull requests](packages/bitbucket-pull-requests) | Review a PR's diff in Muster and merge it after your sign-off |
| [Microsoft Teams](packages/microsoft-teams) | Teams messages meant for you in the Inbox; Teams search for the agent |

## Installing

In Muster, open **⋮ → Modules → Browse**. It lists the modules in this repository. **Install** shows what the module can reach, then installs it switched off. From a terminal, use `agentmuster module add <id>`.

Muster fetches this repository with the git credentials on your desktop, so a private copy works too.

## Layout

```
packages/<id>/            one module per folder: muster-module.json, index.ts, tests, README
templates/hello-world/    a starting point for new modules
registry.json             what Muster's Browse tab lists: id, name, description, version, folder
```

## Writing a module

```sh
npm install          # also links @agentmuster/module-sdk from a shallow clone of Muster (or set MUSTER_DIR)
cp -r templates/hello-world packages/my-module
npm run check        # registry, typecheck and tests
```

Modules import `@agentmuster/module-sdk` for types, `defineModule` and `prFingerprint`, and `@agentmuster/module-sdk/testing` for a fake context to test against. Muster provides the SDK at run time, so don't add it to a module's dependencies. The manifest format is in the SDK's `manifest.schema.json`; point `$schema` at it for editor checks. See `CONTRIBUTING.md` for what a module must do before it's accepted here.

## License

MIT. See `LICENSE`.
