# achilles

a web application for one zeta session. the home page provides a durable zeta chat surface; later slices add page and tool generation.

## layout

- `src/achilles/`: the python control plane and `achilles` command
- `apps/web/`: the react and typescript web app
- `scripts/fulcrum.ts`: builds pinned fulcrum packages into ignored local tarballs
- `fulcrum.rev`: the one fulcrum commit pin

## run

see `AGENTS.md` for the complete clean-worktree setup and check sequence.

```sh
uv run achilles --version
```

add achilles as a trusted global server under `servers` in `$ZETA_HOME/mcp.json`:

```json
{
  "servers": {
    "achilles": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:5190/mcp/"
    }
  }
}
```

zeta binds the page credential header for each session. this setup uses your normal zeta home, which must already be logged in and have a provider and model configured. run `zeta serve --ws 18765 --ws-origin http://127.0.0.1:5190`, then `uv run achilles serve --host 127.0.0.1 --port 5190`, and open `http://127.0.0.1:5190`.

for a separate zeta home with codex, first run `ZETA_HOME=/path/to/zeta-home zeta login codex`, then start serve with that `ZETA_HOME` and explicit `--provider codex --model <your-model>` flags. for a fresh home without credentials, a local ollama instance can instead use `--provider ollama --model qwen3:4b-instruct`; zeta serve starts without contacting ollama, but sending a message requires that model to be installed and running.

if you use `http://localhost:5190` instead, pass that exact origin to `--ws-origin` and make sure another dev server is not listening on `::1` and shadowing achilles.

`FULCRUM_DIR` must point to a clean checkout at the exact commit in `fulcrum.rev`. the web package keeps ordinary dependencies in a committed lockfile; the setup script installs those dependencies with `--frozen-lockfile`, then extracts local tarballs so changing fulcrum archive integrity does not change the lockfile.
