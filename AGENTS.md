# contributing to achilles

run python checks with `uv run ruff check .`, `uv run ruff format --check .`, and `uv run pytest`.
run web checks from `apps/web` with `bun run typecheck`, `bun test`, and `bun run build`.

worktrees live only under `/Users/henry/me/fun/achilles/.worktrees/<name>`. integrate with `git merge`, not rebase, and never force-push.
do not edit zeta, homelab, fulcrum, or gamma from achilles. report any needed change instead.
fulcrum upgrades are explicit pull requests that change `fulcrum.rev`.

this is a private repository. never commit traces, tokens, `.env` files, or real message recipients. fixtures are synthetic only. never send real messages or publish to neenerair without explicit approval.
do not add a framework, orm, queue, or migration framework before a slice needs it.
