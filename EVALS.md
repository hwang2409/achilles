# achilles evals

how to run the eval harness, read its report, and add a task.

## what it is

the harness drives the real product: a private `achilles serve`, a private
`zeta serve`, and a real model, over the same mcp wire a browser would use. for
each task it starts a fresh stack, sends the task prompts, snapshots the
database and layout, then grades the snapshot.

the stack is isolated. `scripts/eval-stack.ts` starts both servers on ephemeral
`127.0.0.1` ports, points `ACHILLES_HOME` and `ZETA_HOME` at a throwaway temp
dir, and verifies every pid, process group, and port is gone on close. it never
touches your live achilles or zeta instance. the child gets only a fixed env
allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`, `NO_PROXY`), so no api-key variable is ever forwarded. the model
runs on your configured zeta account (subscription login, no API keys): provider
credentials are read from the configured account home (`ZETA_ACCOUNT_HOME`,
default your zeta home), with oauth compat on. isolation covers run state, not
the external account.

ci does not call a real model. it runs with `EVAL_BACKEND=scripted`, which swaps
in a local offline model (`ollama/qwen3:4b`) so the grading and harness logic are
tested without spending the account.

## run

run everything from the repo root with `make`. the target installs fulcrum, the
web app, and a chromium for the browser checks on first use.

the one-command flow:

1. `make eval` runs the core suite and compares it with your last core run.
2. read the first line it prints (`PASS 12/12 | ...` or `FAIL 11/12 | ...`),
   then the failures under it. `report.md` has the "changes since" diff.
3. `make eval-history` prints one line per earlier run, newest first: date,
   achilles sha, zeta sha, suite, `N`, pass x/y, turns, tokens, minutes.

- one task: `make eval TASK=harness-smoke`
- several tasks: `make eval TASK=harness-smoke,record-crud`
- the core suite: `make eval` (no `TASK`) runs every task with `suite: "core"`
- another suite: `make eval SUITE=hard` (`SUITE` is `core` or `hard`; see
  "suites" below). `TASK=` still accepts any task, of any suite
- list the suites: `make eval-list` prints every task per suite with its turn
  cap, read from the task files
- repeats: `make eval TASK=record-crud N=3` runs each task `N` times
- override the model: `make eval TASK=record-crud MODEL=provider/model`
  (default resolves from the account home settings)
- an older achilles revision: `make eval ACHILLES_DIR=/path/to/old/checkout`
- a zeta revision: `make eval ZETA_REV=<sha>` (cloned into the cache and pinned)
- keep the full private stack after the run: `make eval KEEP_EVAL=1`
- compare with an earlier run: every run puts a "changes since" section after
  the failures in `report.md` (pass -> fail, fail -> pass, turn or token changes
  over 25%, tasks in only one run). by default (`BASE=last`) the base is the
  newest earlier run of the same suite in the history dir; a run of the same
  `TASK` list counts as the same suite. with no such run there is no diff.
  `BASE=/path/to/run` compares with one saved run folder instead.
- a retained stack for a preview or ux test: `make eval-stack` starts the stack
  for `harness-smoke`, keeps it, and prints the local achilles url, model, tool
  policy (`achilles__*,mcp_discover`), and the retained state path. it never
  forwards api-key env.

budget. each task has an `agent_turns` cap (at most 20); a run that exceeds it
is stopped and graded as `agent_fail` with `cap hit = yes`. the whole command has
a 240-turn cap: `N * sum(agent_turns)` must be `<= 240` or the run refuses to
start. a suite run (`SUITE=core` or `SUITE=hard`, no `TASK`) takes at most 12
tasks: the task loader refuses a 13th, so one full run stays within 12 tasks x 20
model turns. `make eval-list` prints each suite's turn sum, so you can check which
`N` fits.

## suites

each task file carries its own `suite` field; it is the one place that decides
membership. nothing else keeps a copy of the lists (run `make eval-list`).

- `core`: the regression suite, run by `make eval` with no `TASK`. at most 12 tasks.
- `hard`: tasks the agent does not yet pass reliably, run by `make eval SUITE=hard`.
  at most 12 tasks.
- `focused` (the default): run only by name, `make eval TASK=<name>`.

rules:

- a new task starts as `focused`. set `suite` explicitly to add it to a suite run.
- hard-tier rule: when a hard task passes 3/3 after one hardening, harden it again
  or move it to `focused`, so `hard` keeps only open problems.
- a task that only the scripted provider can run or needs (a `provider_error`
  fault, a repro built on the scripted model's fixed replies, or a task that
  grades only the page's delivery path, not the model) carries
  `backend: "scripted"`. a real-model run reports it `unsupported`
  (`scripted_provider`) and spends no turns on it; `EVAL_BACKEND=scripted` runs it.

## read the report

the report is written to the history dir,
`${XDG_CACHE_HOME:-~/.cache}/achilles/evals/<timestamp>-<pid>/` (override with
`REPORT_DIR`). it stays on this machine, outside the checkout: this repo is
public, so never commit eval results. `report.md` reads top to bottom:

1. one result line, for example
   `FAIL 11/12 | achilles 945237c | zeta 378abb4 | model claude/claude-opus-5-5 | 1.9 min | 317147 tokens`.
   the count is passed runs over graded runs; unsupported runs are left out and
   counted in brackets. minutes add up each run's wall time. tokens are input,
   output, cache read, and cache write.
2. the eval tool set (`achilles__*,mcp_discover`, the task's turn cap, no auto
   memory) and how live `make dev` page chats differ from it.
3. `## failures`: one block per failed run with each failed check (expected vs
   actual, and the reason), the agent's last final answer (first 300
   characters), and the snapshot path.
4. the `BASE` diff, when there is a base run.
5. the results: the run header, a table per run (status, score, turns, tool
   calls, approvals, wall time, tokens), a `diagnostics` table (usage detail,
   host tools gap, first-call validity, tool errors, cap hit), unmapped values,
   and the per-task table.

the eval command prints the same result line, tool set, and failures at the end.

the folder holds `report.md`, `report.json` (the same
data plus every check), `cleanup.json` (the teardown proof), and `snapshots/`
with one `<task>-<n>.json` per run. with `KEEP_EVAL=1` the whole private stack,
including zeta sessions and serve logs, is kept under `.cache/evals/<run>/`.

each task row carries:

- status: one of `pass`, `agent_fail`, `harness_error`, `unsupported`,
  `needs_review`, or `agent_fail (goal not reachable on this revision)`.
- score: percent of checks that passed. a task passes when every required check
  passes and score is at least 80.
- checks: the per-check pass/fail list, in `report.json`, with the expected and
  actual evidence for each failed check.
- turns and cap hit: model turns used, and whether the turn cap stopped the run.
- tokens (usage): input, output, reasoning, and cache tokens; `unavailable` when
  a run did not report them.
- transcripts and snapshots: the graded evidence is the snapshot json (pages,
  layouts, tool calls and results, approvals, session history). the full model
  transcript and serve logs live in the retained stack under `.cache/evals/`.
- `make eval-selfcheck-real DIR=/path/to/eval-run` re-grades a run's snapshots
  against the current task definitions, to confirm a grader change did not move a
  real result.

classify a failure before you act on it:

- agent: status `agent_fail` on a revision that supports the task. the model did
  the wrong thing; read the snapshot's tool calls to see how.
- product: status `unsupported` (the revision lacks a `requires` capability) or
  `goal not reachable on this revision` (it lacks a `goal_capabilities` one). the
  product, not the model, is the gap.
- harness: status `harness_error`. a seed or precondition broke, the stack failed
  to start, or static assets were missing. fix the harness or the seed.
- task: the task spec is wrong (impossible steps, wrong expected value). fix the
  task json.
- grader: the agent did the task right but a check failed, or the run landed in
  `needs_review` because the value map did not recognize a valid answer. this is
  a grader false negative; extend the map or fix the check, never relax a real
  assertion.

## add a task

a task is one json file in `evals/tasks/<id>.json`. fields:

- `id`: matches the filename.
- `suite` (optional, `"core"`, `"hard"`, or `"focused"`): defaults to
  `"focused"`. see "suites" above.
- `backend` (optional, only `"scripted"`): the task runs only on the scripted
  provider. the lint requires it on a task with a `provider_error` step.
- `page_plan`: the pages. each has an `alias`, a `source` (`fixture`, `setup`, or
  `created`), `bind_chat`, `create_mode`, and an optional `route`. every
  `fixture` or `setup` page is the home page, except a `fixture` page with a
  `route`: the harness creates that second page (one text block) before the
  run. a `created` page's `route` names the page the agent creates.
- `setup` (optional): the seeds. `tools` (name, operation, collection, optional
  `input_schema`), `records` (id, collection, data), and an `initial_layout`.
- `steps`: the prompts and events, in order. each has an `id`, a `kind`, the
  `page`, and the `chat`. the kinds:
  - `prompt` and `annotate`: send the `prompt` text to the chat over zeta's
    protocol.
  - `browser_prompt`: type the `prompt` into the real page in a browser and send
    it from the page's composer. it can take:
    - `reload` (`{ on, tool?, nth? }`, `on` is `tool_start`, `assistant_delta`,
      or `approval_request`): reload the page once, at the `nth` matching zeta
      event of the turn.
    - `follow_up` (needs `reload`): text typed into the reloaded page while the
      turn may still run.
    - `new_chat` (needs `reload`, no `follow_up`): click "new chat" on the
      reloaded page and send this text there.
    - `delivery_fault` (no `reload`): one fault on the page's socket to zeta for
      this send: `dropped`, `evicted_delivered`, `evicted_queued`,
      `evicted_unknown`, `closed_before_send`, or `closed_after_send`.
  - `reconnect`: drop the zeta connection and resume the chat's session.
  - `user_write`: a user edits a record through the page form. the step names
    a `tool` (an `update` tool) and its `arguments` (a `record_id` and the
    changed fields, no `revision`). the harness reads the record's current
    revision, posts the tool invoke with the page credential, and records the
    result in the snapshot's `user_writes` (never the credential). if the write
    fails or does not bump the revision, the run is `harness_error`. it uses no
    model turn; `chat` only labels the actor.
  - `approval` (optional, `"approve"`, `"deny"`, or `{ tool, decisions }`,
    default `"approve"`): how the harness answers every approval request during
    a model step. `"deny"` sends zeta's real `deny`. `{ tool, decisions }`
    answers that tool's requests in order from the `decisions` list (approve past
    the end; other tools are approved). it is valid only in a task with
    `approval_mode: "ask"`; the lint rejects it anywhere else. the snapshot's `approvals` rows record the `decision`.
  - `during` (optional, a `prompt` step of an `approval_mode: "ask"` task):
    `{ tool, nth?, ... }` acts before the harness answers the `nth` approval
    request of `tool`, with exactly one of: `user_write` (`{ tool, arguments }`,
    a form write like a second chat), `steer` (text steered into the running
    turn), or `restart_zeta: true` (kill the private `zeta serve` and start it
    again; the pending request is never answered, the chat is resumed like a
    page would). rows go to the snapshot's `interjections`.
  - `provider_error` (optional, a `prompt` step, scripted only): `{ status,
    times }`. after the step's first tool result, the next `times` model
    requests fail with HTTP `status`. the task needs `backend: "scripted"`.
- `agent_turns`: the per-task turn cap.
- `checks`: the acceptance table. each has an `id`, a `type`, a `page`, and
  type-specific fields; `required: false` makes a check score-only. the types:
  - pages and tools: `page_exists` (optional `route`), `same_page`,
    `no_new_page`, `count` (rows of a snapshot collection), `tool`,
    `tool_absent`, `refused_tool_name` (a reserved name was refused with
    `invalid_input` at `/bundle/name`), `operations` (one collection has tools
    for every listed operation), `assigned_tools_only` (the chat called only
    the page's assigned tools), `tool_evolution` (a tool gained a field and old
    records stay readable), `schema_roundtrip`.
  - records and results: `record` (some record contains `value`),
    `records_exact` (exactly these records), `updated_record` (a `transition`
    from `before` to `after` values), `successful_result` (a successful call
    of `tool`, optionally containing `value`), `no_duplicate_writes` (no two
    successful calls with the same arguments; with `collection` and `fields`,
    no two records share those values).
  - layouts: `layout_contains`, `layout_update` (one block added to v1 on this
    page only), `layout_restore` (a `restore_version` made the active layout),
    `list_shows`, `detail_selects`, `metric_count` (the first block counts
    `where` records and `inspect_page` reports the count).
  - errors: `no_error`, `no_unrecovered_error` (every failed call of `tool` was
    followed by a success), `error_shown` (the chat shows a failed turn with
    HTTP status `value`).
  - approvals and interruptions: `approval`, `approval_outcomes` (approved
    records end with `set`, denied ones are never asked again and keep their
    seed), `denied_step` (a denied `create_tool` is never retried and the
    answer names it), `reconnect`, `reload` (the reloaded page came back on the
    same chat, attached to the turn, and shows its answer), `new_chat_kept`,
    `delivered_once` (a faulted send reached the model at most once),
    `restart_recovery`, `overwrite_disclosed` (keeping the user's value passes;
    the agent's value passes only if the answer names the user's value).
  - text and browser: `answer_mentions`, `prompt` (a chat's first prompt is
    `text`), `browser_text`, `form_submit`.
- an `approval` check counts approval requests for a `tool`. give `count` for
  an exact number, or `max` to pass when there is at least one request and at
  most `max` (the agent tried, then stopped instead of looping).
- `no_new_page` passes when every page after the run existed before it.
- `answer_mentions` grades a step's final answer text (the snapshot keeps it as
  `answers[step_id]`). it names the `step` and a `value` list; any one value
  must appear, case-insensitively, as a whole token ("12" never matches "120",
  "12.5", or "12th"; "three" never matches "thirty-three"). each value must be a
  fact the seeded records hold: a record's string value, or a count of records
  (in a collection, or where one field equals one value) as digits or a word.
  it is a weak signal (cannot see negation, a list marker, or a record id), so
  every value must be a seeded fact, never free-form expected prose.
- `form_submit` uses the page as a user would. after the agent steps, the
  harness opens the page in a browser and, for each insert form block in the
  active layout, fills every required input from the check's `value` map by the
  input's schema type (`string` is required; `number` and `integer` are
  optional numeric strings; an enum takes its first option; a checkbox stays
  off), submits, and waits for the form's success state. it passes when each
  submit adds exactly one record to the tool's collection, counted in the
  database before and after the submit. a form that shows "this form needs the
  chat" fails with the unsupported field name as evidence; a page with no
  insert form fails. the `value` map is input, not an expectation, so the lint
  does not look for it in the prompt.
- optional `requires` / `goal_capabilities`: capabilities that gate `unsupported`
  and the "goal not reachable" label on older revisions.

a small real task (`evals/tasks/approval-once.json`):

```json
{
  "id": "approval-once",
  "page_plan": [{ "alias": "approval", "source": "fixture", "bind_chat": true, "create_mode": false }],
  "agent_turns": 4,
  "approval_mode": "ask",
  "steps": [{ "id": "write", "kind": "prompt", "page": "approval", "chat": "approval-chat",
              "prompt": "use add_note once to add a note with text approved note" }],
  "setup": { "tools": [{ "name": "add_note", "operation": "insert", "collection": "notes" }], "records": [] },
  "checks": [
    { "id": "approval", "type": "approval", "page": "approval", "tool": "achilles__add_note", "count": 1 },
    { "id": "result", "type": "successful_result", "page": "approval", "tool": "achilles__add_note", "value": { "text": "approved note" } },
    { "id": "record", "type": "records_exact", "page": "approval", "value": [{ "text": "approved note" }] },
    { "id": "no-errors", "type": "no_error", "page": "approval" }
  ]
}
```

grader rules, as rules:

- write the acceptance table (the `checks`) first, before the task runs.
- test the grader first: it must reject a known-bad snapshot and accept a
  known-good one.
- grade by the tool's own schema, not a fixed field name. a check matches the
  value anywhere in the structured result (`structurallyContains`), so an agent
  may name its field freely.
- assert preconditions from the stored state. a broken seed must grade
  `harness_error`, never silently pass or blame the agent.
- a grader that fails a correct agent is worse than none. prefer a false pass you
  can catch over a false fail you cannot.
- one change per pr.
- every task has frozen good and bad references in `evals/references/<id>.json`
  (a `good` snapshot and a `bad` snapshot). data is synthetic only, because this
  repo is public.
- ci self-check: `scripts/eval-selfcheck.test.ts` lints every task and asserts the
  good reference grades `pass` and the bad reference grades `agent_fail`. run it
  with `bun test ./scripts/eval-selfcheck.test.ts`.

## the tasks

`make eval-list` prints every task per suite with its turn cap. each task's file
in `evals/tasks/` holds its prompts and checks; read the file for what it tests.
