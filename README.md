# achilles

a web application for one zeta session. the home page provides a durable zeta chat surface; later slices add page and tool generation.

## setup

```sh
git clone https://github.com/hwang2409/achilles
cd achilles
make dev
```

prerequisites: `make`, `uv`, `bun`, `git`, and `zeta` on `PATH`, plus a provider and model in the zeta home. providers that use an account must be logged in; local ollama does not need credentials.

`make dev` installs dependencies, builds pinned fulcrum packages and the web app when needed, configures achilles in `$ZETA_HOME/mcp.json`, starts or reuses its own zeta serve under the achilles data directory, starts achilles in yolo mode, and opens the app.

set `ACHILLES_APPROVAL=ask` to require approval for tool calls.

create-mode pages can use `inspect_page` for themselves and pages they created with `create_page`; older pages can inspect only themselves.

## metric blocks

use `{"type":"metric","label":"books","collection":"books","count":true}` to count every record in a collection. add `"where":{"field":"status","equals":"reading"}` to count exact JSON scalar matches. equality keeps JSON types separate, except integer and decimal forms of the same number are equal. `"equals":null` counts records where the field is missing or is explicitly JSON null.

## eval harness

run the scripted harness with `make eval TASK=harness-smoke`. the current suite covers `agent-data-access`, `create-and-use-tool-same-chat`, `harness-smoke`, `judge-page-and-annotate`, and `second-chat-tools`. the other six evaluation tasks return in a follow-up PR. use `N=2` for repeats and `MODEL=provider/model` to override the settings-resolved model. `make eval-stack` starts a retained private stack for a ux test; it prints the local achilles url, model, tool policy, and retained state path. the stack uses `--tools 'achilles__*,mcp_discover'` and never forwards api-key environment variables.

use `make stop` to stop only processes started by `make dev`.

use `make dev PORT=5297` for another port. use `ACHILLES_ZETA_DISCOVERY=/path/to/serve.json make dev` to attach to an existing zeta serve instead.

`ZETA_HOME` defaults to `~/.zeta`. the private serve uses this zeta home and its settings; for oauth compatibility, set `oauth_compat = true` under `[anthropic]` in `settings.toml` or set `ZETA_ANTHROPIC_OAUTH_COMPAT=1`. `make dev` backs up an existing mcp file once as `mcp.json.achilles-backup` and preserves other servers. its private discovery file defaults to `~/.local/share/achilles/run/serve.json`.
