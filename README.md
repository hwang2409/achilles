# achilles

a web application for one zeta session. the home page provides a durable zeta chat surface; later slices add page and tool generation.

## setup

```sh
git clone https://github.com/hwang2409/achilles
cd achilles
make dev
```

prerequisites: `uv`, `bun`, `git`, and `zeta` on `PATH`; the zeta home must be logged in and have a provider and model configured. `make dev` installs dependencies, builds pinned fulcrum packages and the web app when needed, configures achilles in `$ZETA_HOME/mcp.json`, starts or reuses zeta serve, starts achilles, and opens the app. use `make stop` to stop only processes started by `make dev`. use `make dev PORT=5297` for another port. set `ACHILLES_APPROVAL=ask` to require approval instead of the default allow mode.

`ZETA_HOME` defaults to `~/.zeta`. `make dev` backs up an existing mcp file once as `mcp.json.achilles-backup` and preserves other servers. if a running zeta serve does not allow the app origin, it is not stopped; the command to restart it with the added origin is printed.
