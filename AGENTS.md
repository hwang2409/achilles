# contributing to achilles

run the ci setup and checks from the repository root:

```sh
uv sync --group test
uv run ruff check .
uv run ruff format --check .
uv run pytest
git clone https://github.com/hwang2409/fulcrum .cache/fulcrum
git -C .cache/fulcrum checkout --detach "$(cat fulcrum.rev)"
(cd .cache/fulcrum && bun install --frozen-lockfile)
bun test scripts/
FULCRUM_DIR=$PWD/.cache/fulcrum bun scripts/fulcrum.ts
git clone https://github.com/hwang2409/zeta .cache/zeta
git -C .cache/zeta checkout --detach "$(cat zeta.rev)"
uv sync --project .cache/zeta --frozen
(cd apps/web && bun run typecheck)
(cd apps/web && bun run build)
ZETA_CHECKOUT=$PWD/.cache/zeta bun scripts/real-zeta-gate.ts

start the web app with `uv run achilles serve --host 127.0.0.1 --port 5190` after building the web assets.
```

clone fulcrum once into the ignored cache; never use a fulcrum worktree or the user's fulcrum checkout. use the pin in `fulcrum.rev`.

worktrees live only under `.worktrees/<name>` under the checkout. integrate with `git merge`, not rebase, and never force-push.
do not edit zeta, homelab, fulcrum, or gamma from achilles. report any needed change instead.
fulcrum upgrades are explicit pull requests that change `fulcrum.rev`.

this repository is public. never commit real traces, transcripts, tokens, `.env` files, hostnames, private network addresses, or real message recipients. fixtures are synthetic only; raw traces stay on the home server.
do not add a framework, orm, queue, or migration framework before a slice needs it.

page-bound MCP tools belong only to the page's top-level Zeta session. child sessions never receive them; bindings use only the standard `Authorization` header and are never echoed.
