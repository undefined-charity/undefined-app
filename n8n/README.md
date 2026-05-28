# n8n workflow backups

This folder holds JSON snapshots of the n8n workflows that back the live app, kept in git for disaster recovery and to make it possible to audit the workflow history alongside the app code.

## Files

- **`consent-api.workflow.json`** — the **Consent API** workflow at `https://n8n.undefined.charity/workflow/vocfoU7tUPCzvTjn`. Receives every `agree` (signing) and `checkin` (scan) POST from the app at `https://n8n.undefined.charity/webhook/dd47554e-384d-4b72-a4d1-22bf17275adc`, decodes the embedded data URLs into CID-referenced inline attachments, routes by `body.action`, and sends a personalised HTML confirmation email via Postal with the pass and signature inline.

## Source of truth

**The live workflow in n8n is authoritative.** This file is a snapshot, not the running definition — editing it here will not change anything in production. To make changes:

1. Edit the workflow in the n8n UI (or via MCP).
2. Publish.
3. Re-export and commit the updated JSON.

## What's NOT in these backups

- **Credential bindings.** The Send Email nodes reference an SMTP credential by ID in the live workflow, but n8n's API doesn't return credential references on export and we wouldn't want them in git anyway. On restore, open each Send Email node and pick the `Postal — tos@undefined.charity` (or current equivalent) SMTP credential from the dropdown.
- **The credentials themselves.** Username/password/host for Postal live in n8n's encrypted credential store. Re-create the credential manually in the n8n UI if you ever rebuild from scratch.
- **Per-execution data.** Pinned test data, execution history, and version history are tenant-local.

## Restoring a workflow

1. n8n UI → **Workflows → Import from File** → pick the JSON.
2. Open each node flagged with a missing credential, select the matching credential from the dropdown, save.
3. **Activate** the workflow (toggle in top-right).
4. Verify the webhook URL matches what the app POSTs to (`src/config.js → endpointUrl`). If the imported workflow gets a new webhook UUID, either update `src/config.js` to match (PR + deploy) or edit the imported Webhook node's path to the old UUID.

## Refreshing the backup

After making changes in n8n, re-export and commit. The cleanest path is via the n8n MCP tools (e.g. through GitHub Copilot CLI):

```sh
# Fetch the current workflow via MCP (saves to a temp file as raw JSON)
# then strip transient fields into the importable shape:
jq '.workflow | {name, nodes, connections, settings, active: false, pinData: {}, meta: {instanceId: "exported-for-backup", builderVariant: "mcp"}}' \
  raw-workflow-from-mcp.json > n8n/consent-api.workflow.json

git add n8n/consent-api.workflow.json
git commit -m "Refresh Consent API workflow backup"
```
