# achilles

the small control plane for agent products and judges. slice 0 provides the python cli and a minimal web app; later slices add trace ingestion, judging, and delivery.

## layout

- `src/achilles/`: the python control plane and `achilles` command
- `apps/web/`: the react and typescript web app
- `scripts/fulcrum.ts`: builds pinned fulcrum packages into ignored local tarballs
- `fulcrum.rev`: the one fulcrum commit pin

## run

```sh
uv sync --group test
uv run achilles --version
uv run pytest

FULCRUM_DIR=/path/to/fulcrum bun scripts/fulcrum.ts
(cd apps/web && bun run typecheck && bun test && bun run build)
```

`FULCRUM_DIR` must point to a clean checkout at the exact commit in `fulcrum.rev`. the web package uses local tarballs so the app and ci build the same pinned fulcrum source without committing generated archives or a lock file whose integrity would change on each pack.
