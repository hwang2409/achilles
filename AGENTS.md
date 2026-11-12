# contributing to achilles

run python checks with `uv run ruff check .`, `uv run ruff format --check .`, and `uv run pytest`.
clone fulcrum once into the ignored cache, never use a fulcrum worktree or the user's fulcrum checkout: `git clone https://github.com/hwang2409/fulcrum .cache/fulcrum && git -C .cache/fulcrum checkout --detach "$(cat fulcrum.rev)"` (use the pin in `fulcrum.rev`), then prepare the pinned packages with `FULCRUM_DIR=$PWD/.cache/fulcrum bun scripts/fulcrum.ts`. run web checks from `apps/web` with `bun run typecheck` and `bun run build`.

worktrees live only under `.worktrees/<name>` under the checkout. integrate with `git merge`, not rebase, and never force-push.
do not edit zeta, homelab, fulcrum, or gamma from achilles. report any needed change instead.
fulcrum upgrades are explicit pull requests that change `fulcrum.rev`.

this repository is public. never commit real traces, transcripts, tokens, `.env` files, hostnames, private network addresses, or real message recipients. fixtures are synthetic only; raw traces stay on the home server.
do not add a framework, orm, queue, or migration framework before a slice needs it.
