# achilles

the small control plane for agent products and judges. slice 0 provides the python cli and a minimal web app; later slices add trace ingestion, judging, and delivery.

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

`FULCRUM_DIR` must point to a clean checkout at the exact commit in `fulcrum.rev`. the web package keeps ordinary dependencies in a committed lockfile; the setup script installs those dependencies with `--frozen-lockfile`, then extracts local tarballs so changing fulcrum archive integrity does not change the lockfile.
