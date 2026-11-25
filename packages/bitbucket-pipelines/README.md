# Bitbucket Pipelines

Runs a repository's custom pipelines, such as deploys, from Muster's ⚡ Actions panel.

It reads the pipeline names and variables from `bitbucket-pipelines.yml` on the default branch, so the form offers each pipeline's variables with their defaults. The preview shows:

- the build each environment is serving, from the `current-build-version` header of the health URLs you set;
- the last run of that pipeline, and the build number this run will get;
- a release number, if you set an offset.

After you confirm, it triggers the pipeline and follows each step until it finishes.

## What it needs

An Atlassian API token with scopes, created at <https://id.atlassian.com/manage-profile/security/api-tokens> (choose **Create API token with scopes**, then **Bitbucket**), with `read:repository:bitbucket`, `read:pipeline:bitbucket` and `write:pipeline:bitbucket`. Enter it with your Atlassian account email. A repository or workspace access token also works; leave the email empty for one.

## Settings

Workspace and repository (from the repository URL), the default branch, optional health URLs per pipeline (`deploy-production = https://example.com/health`), and an optional release offset added to build numbers.
