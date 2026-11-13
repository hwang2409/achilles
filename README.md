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

run achilles on a port whose exact browser origin is allowed by zeta, for example `zeta serve --ws-origin http://127.0.0.1:5190` with `uv run achilles serve --host 127.0.0.1 --port 5190`, then open `http://127.0.0.1:5190`. if you use `http://localhost:5190`, make sure another dev server is not listening on `::1` and shadowing achilles; open the exact origin passed to `--ws-origin`.

`FULCRUM_DIR` must point to a clean checkout at the exact commit in `fulcrum.rev`. the web package keeps ordinary dependencies in a committed lockfile; the setup script installs those dependencies with `--frozen-lockfile`, then extracts local tarballs so changing fulcrum archive integrity does not change the lockfile.
