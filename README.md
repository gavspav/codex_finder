# Codex Finder

A small local launcher that reads Codex's configured projects and shows them in a Finder-style icon view.

## Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:4821
```

Click `Open` on a project to launch it in Codex. The server uses:

```bash
/Applications/Codex.app/Contents/Resources/codex app /path/to/folder
```

Tested on macOS. Other platforms need `CODEX_CLI` set to a valid Codex CLI path.

## Settings

You can override the fallback scanned folder or port:

```bash
CODEX_FINDER_ROOT="$HOME/Documents/Codex" CODEX_FINDER_PORT=4821 npm start
```

Favourites are stored in `.codex-finder-state.json` beside the app.
