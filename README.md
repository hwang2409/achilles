# achilles

a web application for one zeta session. the home page provides a durable zeta chat surface; later slices add page and tool generation.

## setup

```sh
git clone https://github.com/hwang2409/achilles
cd achilles
make dev
```

prerequisites: `make`, `uv`, `bun`, and `git`, plus a provider and model in the zeta home. `make dev` prepares its pinned zeta checkout; set `ACHILLES_USE_PATH_ZETA=1` only when you want to use `zeta` on `PATH`. providers that use an account must be logged in; local ollama does not need credentials.

`make dev` installs dependencies, prepares pinned zeta in `.cache/zeta` with its own virtual environment, builds pinned fulcrum packages and the web app when needed, configures achilles in `$ZETA_HOME/mcp.json`, starts or reuses its own zeta serve under the achilles data directory, starts achilles in yolo mode, and opens the app. to use zeta from `PATH` instead, set `ACHILLES_USE_PATH_ZETA=1`; an older path zeta is rejected without changing it.

set `ACHILLES_APPROVAL=ask` to require approval for tool calls.

create-mode pages can use `inspect_page` for themselves and pages they created with `create_page`; older pages can inspect only themselves.

## pages

pages are React/TypeScript packages compiled by achilles. `create_page` accepts source and npm dependencies, or creates a minimal React shell when the package is omitted. `write_page` appends a compiled revision, and `restore_version` restores code or a data tool by appending another revision so history is never rewritten.

## eval harness

see [EVALS.md](EVALS.md) for how to run one task or the suite, read the report, and add a task.

run one scripted task with `make eval TASK=record-crud`. the suite covers page data, concurrent edits, approvals, reconnects, restarts, and multi-chat behavior. use `N=2` for repeats and `MODEL=provider/model` to override the settings-resolved model. `make eval-stack` starts a retained private stack for a ux test; it prints the local achilles url, model, tool policy, and retained state path. the stack uses `--tools 'achilles__*,mcp_discover'` and never forwards api-key environment variables.

use `make stop` to stop only processes started by `make dev`.

use `make dev PORT=5297` for another port. use `ACHILLES_ZETA_DISCOVERY=/path/to/serve.json make dev` to attach to an existing zeta serve instead. the attached serve and its mcp commands must be provided by the same zeta selection; default runs use `.cache/zeta/.venv/bin/zeta`.

`ZETA_HOME` defaults to `~/.zeta`. the private serve uses this zeta home and its settings; for oauth compatibility, set `oauth_compat = true` under `[anthropic]` in `settings.toml` or set `ZETA_ANTHROPIC_OAUTH_COMPAT=1`. `make dev` backs up an existing mcp file once as `mcp.json.achilles-backup` and preserves other servers. its private discovery file defaults to `~/.local/share/achilles/run/serve.json`.
