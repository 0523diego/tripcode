---
name: sync-notion
description: Sync a TripCode trip to a Notion page so the user can read it on their phone, including ticket PDFs/images. Use when the user says "同步到 Notion", "手機看行程", "把行程放到 Notion", "sync to Notion", "update the Notion page". Also explains the one-time Notion setup.
---

# Sync a trip to Notion

Run (the page is created on first run and rewritten in place afterwards):

```bash
npm run tripcode -- export notion <tripId> [--file variant-b.ts] [--pretty]
```

- Preview without any network call or token: add `--dry-run` (prints the Notion block JSON).
- Always run `npm run check -- <tripId>` first; the page summary shows the check status.
- Tell the user the page URL from the output (`url`) and that attachments under `trips/<id>/tickets/` are uploaded too (≤ 20 MB each; unchanged files are not re-uploaded).
- Page id and file hashes are stored in `trips/<id>/.notion.json` (gitignored). Do not edit it by hand; deleting it makes the next sync create a new page.
- Edits made in Notion are overwritten on the next sync: the plan file is the source of truth.

## If it says NOTION_TOKEN / NOTION_PARENT_PAGE_ID is missing

Never ask the user to paste the token into chat. Walk them through it, they edit `.env` themselves:

1. Open https://www.notion.so/profile/integrations, create an **Internal** integration, copy its secret.
2. Put `NOTION_TOKEN=<secret>` in `.env` (copy from `.env.example`).
3. In Notion create a page for trips, ⋯ → **Connections** → add the integration.
4. Copy the page URL (or its 32-character id) into `.env` as `NOTION_PARENT_PAGE_ID=`.

A 404 from Notion almost always means step 3 was skipped. Never print or log the token.
