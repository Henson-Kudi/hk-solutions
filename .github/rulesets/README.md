# Branch rulesets

GitHub does not read this folder. `main.json` is the ruleset for `main`, kept in the repo so the
protection is reviewable and can be re-created.

## What `main.json` enforces

- Changes reach `main` only through a pull request.
- The `pr-checks` job (`.github/workflows/pr-checks.yml`) must be green.
- Linear history: squash or rebase merges only, no merge commits.
- No force pushes to `main` and no deleting it.
- Review conversations must be resolved before merging.

`required_approving_review_count` is `0`. Pull requests are opened from the owner's own account, and
GitHub does not let an author approve their own pull request, so requiring one approval would block
every merge. Raise it to `1` when a second person or a separate bot account opens the pull requests.

## Apply it

Create it once (needs admin rights on the repo):

```sh
gh api --method POST repos/Henson-Kudi/hk-solutions/rulesets --input .github/rulesets/main.json
```

Or in the browser: Settings, Rules, Rulesets, New ruleset, Import a ruleset, and pick `main.json`.

To change it later, edit `main.json` in a pull request, then update the live ruleset with its id:

```sh
gh api repos/Henson-Kudi/hk-solutions/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api --method PUT repos/Henson-Kudi/hk-solutions/rulesets/<id> --input .github/rulesets/main.json
```
