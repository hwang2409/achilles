# contributing to achilles

run python checks with `uv run ruff check .`, `uv run ruff format --check .`, and `uv run pytest`.
prepare the pinned fulcrum packages with `FULCRUM_DIR=/path/to/fulcrum bun scripts/fulcrum.ts`, then run web checks from `apps/web` with `bun run typecheck` and `bun run build`.

worktrees live only under `.worktrees/<name>` under the checkout. integrate with `git merge`, not rebase, and never force-push.
do not edit zeta, homelab, fulcrum, or gamma from achilles. report any needed change instead.
fulcrum upgrades are explicit pull requests that change `fulcrum.rev`.

this repository is public. never commit real traces, transcripts, tokens, `.env` files, hostnames, tailnet addresses, or real message recipients. fixtures are synthetic only; raw traces stay on neenerair.
do not add a framework, orm, queue, or migration framework before a slice needs it.
