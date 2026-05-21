# Codex Finder

A small local launcher that scans `~/Documents/Codex` and shows Codex workspaces in a Finder-style icon view.

## Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:4821
```

Click `Open` on a folder to launch it in Codex. The server uses:

```bash
/Applications/Codex.app/Contents/Resources/codex app /path/to/folder
```

## Settings

You can override the scanned folder or port:

```bash
CODEX_FINDER_ROOT="$HOME/Documents/Codex" CODEX_FINDER_PORT=4821 npm start
```

Favourites are stored in `.codex-finder-state.json` beside the app.
