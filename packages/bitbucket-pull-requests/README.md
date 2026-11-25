# Bitbucket pull requests

Review and merge Bitbucket Cloud pull requests from Muster, without opening Bitbucket.

PR links the agent posts in a session appear in that session's **Files → Pull requests** tab:

1. **Review diff** shows the full diff file by file, with the branches, build statuses, approvals and anything that blocks the merge.
2. **I've reviewed this diff** records your sign-off on the exact source commit, target commit and diff you read. Muster fetches the PR again first, so a push after you opened it is caught.
3. **Merge…** checks the live PR again and asks you to confirm. It merges only if the commits and diff still match your review and nothing blocks it: conflicts, unresolved tasks, failed or pending builds, Bitbucket's own blocking merge checks, or a target branch outside the allowed list.

The merge is one call to Bitbucket's merge API, as a merge commit, and the source branch is kept. A response that doesn't say "merged" is not retried. Bitbucket's API has no way to merge only if the commit is unchanged, so avoid pushing while you confirm.

The agent gets one read-only tool, `bitbucket_pr_context`. It can read a PR, but it can't approve, comment on or merge one.

## What it needs

An Atlassian API token with scopes, created at <https://id.atlassian.com/manage-profile/security/api-tokens> (choose **Create API token with scopes**, then **Bitbucket**), with `read:repository:bitbucket`, `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`, plus your Atlassian account email. Your account also needs permission to merge into the target branch.

## Settings

- **Allowed target branches:** `staging, main` by default.
- **Approvals needed from others:** 0 by default, since your review is the sign-off.
- **Require a successful build:** off by default. Failed or pending builds always block.
