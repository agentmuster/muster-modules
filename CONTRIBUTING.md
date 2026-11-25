# Contributing a module

Modules run on people's own computers with their tokens, so every module here is reviewed against this list before it's merged.

## Checklist

- **Network:** every host the module contacts is listed in `network` in its manifest. Muster blocks the rest, but the list is also what users approve when they install.
- **Secrets:** tokens are `secret` settings. Never log them, return them, or include them in errors.
- **Agent tools only read.** Anything that changes something in another service is an action.
- **Actions preview first.** An action's `preview` changes nothing and says exactly what `run` will do. Mark it `confirm: always` unless it's harmless.
- **Errors explain themselves.** Missing settings, a wrong token scope or a 403 should tell the user what to fix.
- **Tests:** the module has tests that run against a fake context, with no real accounts or network.
- **Docs:** the module's README says what it does, which token or account it needs, with which scopes, and where to create it.

## Pull requests

One module, or one change to a module, per pull request. Bump the module's version, and update `registry.json` in the same pull request.

## Conduct

Be kind and assume good intent. This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
