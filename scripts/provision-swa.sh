#!/usr/bin/env bash
#
# provision-swa.sh — Provision the Azure Static Web App that hosts the BOM Squad site.
#
# Creates a NEW resource group and a Free-tier Static Web App inside it, WITHOUT
# linking a GitHub repo (no --source/--branch/--login-with-github). We deploy via
# our own GitHub Actions workflow (.github/workflows/deploy-site.yml) using a
# deployment token stored in the AZURE_STATIC_WEB_APPS_API_TOKEN repo secret —
# that keeps the deploy workflow under our version control instead of the
# auto-generated one Azure would otherwise create.
#
# Idempotent: safe to re-run. Every resource-creating step first checks whether
# the resource already exists and skips creation if so.
#
# Environment variables (all optional; defaults shown):
#   RESOURCE_GROUP   Resource group to create/use.                Default: rg-bomsquad
#   LOCATION         Azure region for the resource group and app. Default: eastus2
#   APP_NAME         Static Web App name — must be globally       Default: bomsquad
#                    unique across Azure.
#
# Usage:
#   ./scripts/provision-swa.sh
#   RESOURCE_GROUP=rg-bomsquad-dev APP_NAME=bomsquad-dev ./scripts/provision-swa.sh
#
# Requires: Azure CLI ('az'), logged in ('az login') with a subscription selected.

set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-bomsquad}"
LOCATION="${LOCATION:-eastus2}"
APP_NAME="${APP_NAME:-bomsquad}"

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. Preconditions -------------------------------------------------------

command -v az >/dev/null 2>&1 \
  || die "Azure CLI ('az') not found. Install: https://learn.microsoft.com/cli/azure/install-azure-cli"

if ! az account show >/dev/null 2>&1; then
  die "Not logged in to Azure CLI. Run 'az login' first."
fi

SUBSCRIPTION_NAME="$(az account show --query name -o tsv)"
log "Azure subscription: ${SUBSCRIPTION_NAME}"
log "Resource group:      ${RESOURCE_GROUP}"
log "Location:            ${LOCATION}"
log "App name:            ${APP_NAME}"

# --- 2. Ensure the Microsoft.Web resource provider is registered -----------
# (Static Web Apps is served by the Microsoft.Web provider.)

PROVIDER_STATE="$(az provider show --namespace Microsoft.Web --query registrationState -o tsv 2>/dev/null || echo 'NotRegistered')"
if [[ "${PROVIDER_STATE}" != "Registered" ]]; then
  log "Registering resource provider Microsoft.Web (current state: ${PROVIDER_STATE})..."
  az provider register --namespace Microsoft.Web --wait
else
  log "Resource provider Microsoft.Web already registered."
fi

# --- 3. Resource group (idempotent) -----------------------------------------

if [[ "$(az group exists --name "${RESOURCE_GROUP}")" == "true" ]]; then
  log "Resource group '${RESOURCE_GROUP}' already exists, skipping creation."
else
  log "Creating resource group '${RESOURCE_GROUP}' in '${LOCATION}'..."
  az group create --name "${RESOURCE_GROUP}" --location "${LOCATION}" --output none
fi

# --- 4. Static Web App (idempotent, Free tier, no GitHub linkage) ----------

if az staticwebapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" >/dev/null 2>&1; then
  log "Static Web App '${APP_NAME}' already exists in '${RESOURCE_GROUP}', skipping creation."
else
  log "Creating Static Web App '${APP_NAME}' (Free tier, no GitHub integration)..."
  # Deliberately no --source / --branch / --login-with-github: we deploy via our own
  # GitHub Actions workflow using a deployment token, not Azure's auto-generated
  # GitHub Action / repo linkage.
  az staticwebapp create \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --location "${LOCATION}" \
    --sku Free \
    --output none
fi

# --- 5. Report hostname and retrieve the deployment token ------------------

DEFAULT_HOSTNAME="$(az staticwebapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query defaultHostname -o tsv)"
log "Static Web App hostname: https://${DEFAULT_HOSTNAME}"

DEPLOYMENT_TOKEN="$(az staticwebapp secrets list --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query 'properties.apiKey' -o tsv)"

cat >&2 <<'BANNER'

=====================================================================
DEPLOYMENT TOKEN — SECRET. Printed once below. Do not paste it into
chat, issues, PRs, commit messages, or any command line/log that gets
recorded — pipe it directly into 'gh secret set' instead (see below).
=====================================================================
BANNER

# Printed to stdout only (not a log-decorated stream) so it can be piped/redirected
# by the maintainer without also being echoed into stderr-captured CI logs.
printf '%s\n' "${DEPLOYMENT_TOKEN}"

cat >&2 <<EOF

Store it as a GitHub Actions repo secret — this reads the token from stdin,
never as an argv literal, so it never lands in shell history or a process
list. Run this exact command (repo defaults to the current git remote if
--repo is omitted; shown explicitly here for clarity):

  az staticwebapp secrets list --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query 'properties.apiKey' -o tsv | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo mcfbytes/BomSquad

EOF

log "Done."
