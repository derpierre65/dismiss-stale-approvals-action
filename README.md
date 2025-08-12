# dismiss-stale-approvals

A GitHub action to automatically dismiss stale approvals on pull requests.
Unlike the built in GitHub protection, this action will compare the `git range-diff` of the new version against the previous version, and only dismiss approvals if the diff has changed.

## Example

Add the below worklow to your repository's `.github/workflows` directory.

```yaml
name: Dismiss stale pull request approvals

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened

permissions:
  actions: read
  contents: read
  pull-requests: write

jobs:
  dismiss-stale-approvals:
    runs-on: ubuntu-latest
    steps:
      - name: 🛎 Checkout
        uses: actions/checkout@v4

      - name: Dismiss stale pull request approvals
        uses: derpierre65/dismiss-stale-approvals-action@main
        with:
#          dismiss-message: 'Your custom dismiss message'
#          re-request: false
#          fetch-depth: 250
          github-token: ${{ secrets.GITHUB_TOKEN }}
```
