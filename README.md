# Comet ChatGPT Bridge — v0.1

This package contains two pieces:

- `extension/` — Chromium/Comet extension that reads and controls the active tab.
- `server/` — local Node.js bridge + MCP server.

## What v0.1 can do

- Read the active page (title, URL, visible text, interactive elements)
- Click by CSS selector or visible text
- Type into fields by CSS selector
- Navigate the active tab
- Capture a screenshot
- List tabs and activate a tab

## Install the local server

1. Install Node.js 20+.
2. Open PowerShell in `server/`.
3. Run:

   npm install
   npm start

The bridge listens only on `127.0.0.1:8788` for the Comet extension.

## Load the extension in Comet

1. Open Comet's extensions page (Chromium extensions manager).
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extension/` folder.
5. Start the local server first, then open Comet. The extension badge should show `ON` when connected.

## MCP connection

`server.js` exposes the MCP tools over **stdio**. This is ideal for local MCP clients and for validating the browser bridge first.

For ChatGPT itself, the next step is to expose an authenticated **HTTPS Streamable HTTP MCP endpoint** (for example through a secure tunnel) and then connect that MCP/plugin in ChatGPT. Do not expose port 8788 directly to the internet.

## Security notes

This extension has broad page access because browser control requires it. Only load it from this local folder, keep the bridge bound to `127.0.0.1`, and disable/remove the extension when you do not want browser control.

Before adding remote ChatGPT connectivity, add authentication and explicit confirmations for sensitive actions such as payments, deleting resources, sending messages, or changing security settings.
