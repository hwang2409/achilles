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

- one task: `make eval TASK=harness-smoke`
- several tasks: `make eval TASK=harness-smoke,record-crud`
- the whole suite: `make eval` (no `TASK`) — runs only the core 12 (see
  "core vs focused-only" below); `TASK=` still accepts any task, core or not
- repeats: `make eval TASK=record-crud N=3` runs each task `N` times
- override the model: `make eval TASK=record-crud MODEL=provider/model`
  (default resolves from the account home settings)
- an older achilles revision: `make eval ACHILLES_DIR=/path/to/old/checkout`
- a zeta revision: `make eval ZETA_REV=<sha>` (cloned into the cache and pinned)
- keep the full private stack after the run: `make eval KEEP_EVAL=1`
- a retained stack for a preview or ux test: `make eval-stack` starts the stack
  for `harness-smoke`, keeps it, and prints the local achilles url, model, tool
  policy (`achilles__*,mcp_discover`), and the retained state path. it never
  forwards api-key env.

budget. each task has an `agent_turns` cap; a run that exceeds it is stopped and
graded as `agent_fail` with `cap hit = yes`. the whole command has a 240-turn cap:
`N * sum(agent_turns)` must be `<= 240` or the run refuses to start. the core
suite sums to 82 turns, so a full run (`make eval`, no `TASK`) accepts `N` up to 2.

## core vs focused-only

each task file carries its own `suite` field (`"core"` or `"focused"`); this is
the one place that decides membership — nothing else duplicates the list. a
full run (`make eval` with no `TASK`) runs only tasks with `suite: "core"`.
`make eval TASK=<name>` runs any task by name regardless of `suite`.

the 12 core tasks (full runs):

- `agent-data-access`, `approval-once`, `create-and-use-tool-same-chat`,
  `harness-smoke`, `invalid-authoring-recovery`, `judge-page-and-annotate`,
  `reading-list-one-prompt`, `reading-metric-count`, `reconnect-recovery`,
  `record-crud`, `tool-version-fresh-chat`, `update-layout-from-page-chat`

focused-only tasks (run with `TASK=<name>`, never in a full run):

- `browser-controller-slot`, `count-question`, `page-awareness`,
  `page-tool-without-create-mode`, `second-chat-tools`, `undo-layout-change`

rule: a new task starts as focused-only. set `suite: "core"` explicitly to add
a task to full runs; a task with no `suite` field, or `suite: "focused"`, is
focused-only.

## read the report

the report is written to `evals/reports/<timestamp>-<pid>/` (override with
`REPORT_DIR`). the folder holds `report.md` (the table), `report.json` (the same
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
- `suite` (optional, `"core"` or `"focused"`): defaults to `"focused"`. a new
  task starts as focused-only; see "core vs focused-only" above.
- `page_plan`: the pages. each has an `alias`, a `source` (`fixture`, `setup`, or
  `created`), `bind_chat`, `create_mode`, and an optional `route`.
- `setup` (optional): the seeds. `tools` (name, operation, collection, optional
  `input_schema`), `records` (id, collection, data), and an `initial_layout`.
- `steps`: the prompts. each has an `id`, a `kind` (`prompt`, `annotate`,
  `reconnect`), the `page` and `chat`, and the `prompt` text.
- `agent_turns`: the per-task turn cap.
- `checks`: the acceptance table (see below). each has an `id`, a `type`, a
  `page`, and type-specific fields.
- `answer_mentions` grades a step's final answer text (the snapshot keeps it as
  `answers[step_id]`). it names the `step` and a `value` list; any one value
  must appear, case-insensitively, as a whole token ("12" never matches "120",
  "12.5", or "12th"; "three" never matches "thirty-three"). each value must be a
  fact the seeded records hold: a record's string value, or a count of records
  (in a collection, or where one field equals one value) as digits or a word.
  it is a weak signal (cannot see negation, a list marker, or a record id), so
  every value must be a seeded fact, never free-form expected prose.
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

the 18 tasks in `evals/tasks/` (12 core, 6 focused-only — see "core vs
focused-only" above):

- `agent-data-access`: a bound chat reads all seeded records with `list_records`.
- `approval-once`: with approval on, add exactly one note after one approval.
- `browser-controller-slot`: create `/eval-smoke` and confirm the text is visible
  in the browser.
- `count-question`: with create mode off, ask how many of 5 seeded books are
  done; the final answer must say 3 and the records stay unchanged.
- `create-and-use-tool-same-chat`: author a page-local insert tool and use it in
  the same chat.
- `harness-smoke`: the smoke task; create a page with one text block.
- `invalid-authoring-recovery`: a reserved tool name is refused, then a valid tool
  is authored and used.
- `judge-page-and-annotate`: build a review page with list and detail blocks, then
  author and use annotation tools.
- `page-awareness`: with create mode off, ask what the page does; the agent reads
  the page with `inspect_page` and changes no records.
- `page-tool-without-create-mode`: with create mode off, add a contact using only
  the page's assigned insert tool.
- `reading-list-one-prompt`: from one prompt, build a reading-list page, then add,
  update, and list a book.
- `reading-metric-count`: add a metric that counts "done" books and verify it.
- `reconnect-recovery`: write a note, reconnect, then read it back.
- `record-crud`: insert two records, update one, then list all.
- `second-chat-tools`: two chats on one page both read the seeded note.
- `tool-version-fresh-chat`: add an optional field to a tool while old records keep
  working.
- `undo-layout-change`: change a page layout, then undo it with `restore_version`
  so the active layout is a copy of v1.
- `update-layout-from-page-chat`: use `update_layout` to add a list block for the
  page's records.
