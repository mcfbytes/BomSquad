# Azure Static Web Apps setup

Runbook for provisioning and operating the Azure Static Web App that hosts the
BOM Squad site. One-time setup is **(human)** work — it needs Azure and GitHub
credentials only the maintainer holds.

## Current deployment

Provisioned 2026-07-22 on the Free tier (no cost). This section records what
actually exists; the rest of the document is the general procedure.

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| Subscription   | Personal Pay-As-You-Go                                                 |
| Resource group | `rg-bomsquad` (`eastus2`)                                              |
| Static Web App | `bomsquad`, SKU `Free`                                                 |
| URL            | <https://gray-forest-0c2914a0f.7.azurestaticapps.net>                  |
| Deploy secret  | `AZURE_STATIC_WEB_APPS_API_TOKEN` — already set on `mcfbytes/BomSquad` |

Deep-link fallback is verified working: `/chip/ym2151` returns HTTP 200 with the
app shell rather than a 404.

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and logged in: `az login`, then confirm the right subscription is selected with `az account show`.
- [GitHub CLI](https://cli.github.com/) installed and logged in: `gh auth login`.
- Write access to the `mcfbytes/BomSquad` repo (to set repo secrets).
- An Azure subscription that can create resource groups and Free-tier Static Web Apps.

## 1. Provision the Azure resources

Run the provisioning script from the repo root:

```sh
./scripts/provision-swa.sh
```

This creates a new resource group and a Free-tier Static Web App, **without**
linking a GitHub repo — deployment happens through our own workflow
(`.github/workflows/deploy-site.yml`) using a deployment token, not Azure's
auto-generated GitHub Action. The script is idempotent; re-running it skips
any resource that already exists.

Defaults (override via environment variables):

| Variable         | Default       | Meaning                                       |
| ---------------- | ------------- | --------------------------------------------- |
| `RESOURCE_GROUP` | `rg-bomsquad` | Resource group name                           |
| `LOCATION`       | `eastus2`     | Azure region                                  |
| `APP_NAME`       | `bomsquad`    | Static Web App name (must be globally unique) |

Example with overrides:

```sh
RESOURCE_GROUP=rg-bomsquad-dev APP_NAME=bomsquad-dev ./scripts/provision-swa.sh
```

The script prints the app's default hostname (`https://<name>.azurestaticapps.net`,
or similar) and, at the end, prints the deployment token **once** along with
the exact command to store it as a repo secret.

## 2. Store the deployment token as a repo secret

The script prints a ready-to-run command of this shape:

```sh
az staticwebapp secrets list --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query 'properties.apiKey' -o tsv | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo mcfbytes/BomSquad
```

Run it (or re-run it any time you need to rotate the secret — Azure lets you
regenerate the token via `az staticwebapp secrets reset-api-key`). The token
is piped directly from `az` into `gh secret set` via stdin so it never
appears as a command-line argument, in shell history, or in a process list.

Verify the secret is set:

```sh
gh secret list --repo mcfbytes/BomSquad
```

You should see `AZURE_STATIC_WEB_APPS_API_TOKEN` in the list (GitHub never
shows secret values, only names and update times).

## 3. Deploy

Deployment is automatic: pushing to `master` with changes under `site/**`,
`dist/bomsquad.sqlite`, or the workflow file itself triggers
`.github/workflows/deploy-site.yml`, which builds the Angular app and
deploys it. You can also trigger it manually:

```sh
gh workflow run deploy-site.yml --repo mcfbytes/BomSquad
```

## 4. Verify the deployment

Get the app's hostname if you don't already have it:

```sh
az staticwebapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query defaultHostname -o tsv
```

Check the site shell loads:

```sh
curl -sI "https://<hostname>/" | head -1
# expect: HTTP/2 200
```

Check a deep link resolves to the app shell instead of a 404 — this is what
`navigationFallback` in `site/public/staticwebapp.config.json` is for:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "https://<hostname>/chip/ym2151"
# expect: 200

curl -s "https://<hostname>/chip/ym2151" | grep -q '<app-root' && echo "serves app shell"
```

Both requests must return `200` with the same HTML document `/` serves
(the Angular app shell), not Azure's default 404 page.

## Tearing down

Delete everything provisioned by the script in one step:

```sh
az group delete --name "$RESOURCE_GROUP"
```

This deletes the Static Web App along with the resource group. It does not
touch the `AZURE_STATIC_WEB_APPS_API_TOKEN` repo secret — remove that
separately if you're decommissioning permanently:

```sh
gh secret remove AZURE_STATIC_WEB_APPS_API_TOKEN --repo mcfbytes/BomSquad
```

Pull request preview environments are torn down automatically by
`deploy-site.yml`'s `close_pull_request` job when a PR closes; you don't
need to do this by hand per-PR.

## Troubleshooting

**`az staticwebapp create` fails with a name-already-taken error.**
`APP_NAME` must be globally unique across all of Azure (it becomes part of
the `*.azurestaticapps.net` hostname). Pick a different `APP_NAME`.

**Deploy workflow step "Deploy to Azure Static Web Apps" is skipped.**
`AZURE_STATIC_WEB_APPS_API_TOKEN` isn't set on the repo, or the workflow run
came from a fork PR (forks never receive repo secrets). Re-check step 2. If
the token was set after a run started, re-run the workflow rather than
re-running just the failed job.

**Deep link returns a 404 instead of the app shell.**
Most likely `staticwebapp.config.json` didn't make it into the deployed
output. Confirm it's present at `site/public/staticwebapp.config.json` (Angular
copies everything under `site/public/` into the build root via the `assets`
glob in `angular.json`) and that it ends up at the root of
`site/dist/bom-squad-site/browser/` after `npm run build --workspace
@bomsquad/site`. Also check the `exclude` list in `navigationFallback` isn't
inadvertently matching the route you're testing.

**`gh secret set` prompts for confirmation or fails with a permissions error.**
You need admin/write access to `mcfbytes/BomSquad` to set repo secrets, and
`gh auth login` must be authenticated as an account with that access.

**Provider registration step hangs.**
`az provider register --namespace Microsoft.Web --wait` can take a few
minutes on a subscription that has never used Azure Web/Static Web Apps
before. Let it finish; it's a one-time step per subscription.

**Token compromised or needs rotation.**
Regenerate it and update the secret:

```sh
az staticwebapp secrets reset-api-key --name "$APP_NAME" --resource-group "$RESOURCE_GROUP"
az staticwebapp secrets list --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query 'properties.apiKey' -o tsv | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo mcfbytes/BomSquad
```
