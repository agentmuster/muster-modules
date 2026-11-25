# Muster modules

Modules connect [Muster](https://github.com/rampradeep84/muster) to other services. A module can add:

- **actions** you run from Muster's Actions panel, such as a deploy, always with a preview and your confirmation first;
- **Inbox feeds**, such as Teams messages meant for you, which Muster groups into requests;
- **agent tools** the agent can call while it works, such as searching Teams;
- **providers** for Muster features, such as reviewing and merging pull requests.

Each module is a folder with a `muster-module.json` manifest and an entry file, published as its own npm package. Muster will be able to browse this repo's `registry.json` and install modules from the app.

## Status

Early. The first modules (Bitbucket Pipelines, Bitbucket pull requests and Microsoft Teams) still live in the Muster repo. They move here once the module SDK, `@agentmuster/module-sdk`, is published and Muster can install modules from npm.

## Layout

```
packages/<module>/        one module per folder, published as @agentmuster/module-<name>
templates/                a starting point for new modules
registry.json             what Muster's Browse tab lists: name, description, permissions, latest version
```

## Writing a module

See the Modules section of the [Muster README](https://github.com/rampradeep84/muster#modules) for the manifest and the module API, and `CONTRIBUTING.md` for what a module must do before it's accepted here.

## License

MIT. See `LICENSE`.
