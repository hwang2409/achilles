import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from jsonschema import Draft202012Validator

from achilles.pages import CREATE_PAGE_SCHEMA, LAYOUT_SCHEMA, PageStore, validate_layout
from achilles.records import call_record
from achilles.tools import ValidationError
from achilles.validation import error_document

_BUNDLE = {
    "format_version": 1,
    "kind": "data_operation",
    "name": "add_book",
    "description": "add a book",
    "input_schema": {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
        "additionalProperties": False,
    },
    "implementation": {
        "operation": "insert",
        "collection": "books",
        "data_schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
            "additionalProperties": False,
        },
    },
}


def _update_page(store: PageStore) -> str:
    store.set_create_mode("home", True)
    page, _, _ = store.create_page(
        "/reading",
        "reading",
        {"blocks": [{"type": "list", "title": "books", "collection": "books"}]},
        tools=[_BUNDLE],
    )
    store.set_create_mode(page["id"], True)
    return page["id"]


@pytest.mark.parametrize(
    ("layout", "assigned_tools"),
    [
        ({"blocks": []}, set()),
        ({"blocks": [{"type": "text", "text": "ok"}]}, set()),
        ({"blocks": [{"type": "detail", "title": "x", "fields": ["id"]}]}, set()),
        ({"blocks": [{"type": "metric", "label": "runs", "value": "3"}]}, set()),
        (
            {
                "blocks": [
                    {
                        "type": "metric",
                        "label": "reading",
                        "collection": "books",
                        "count": True,
                        "where": {"field": "status", "equals": "reading"},
                    }
                ]
            },
            set(),
        ),
        ({"blocks": [{"type": "list", "title": "runs", "collection": "runs"}]}, set()),
        ({"blocks": [{"type": "form", "title": "add", "tool": "add_run"}]}, {"add_run"}),
    ],
)
def test_every_layout_variant_matches_catalog_schema(layout, assigned_tools):
    validate_layout(layout, assigned_tools)
    assert Draft202012Validator(LAYOUT_SCHEMA).is_valid(layout)


@pytest.mark.parametrize(
    "layout",
    [
        {"blocks": [{"type": "text", "text": "ok", "extra": True}]},
        {"blocks": [{"type": "text", "text": 1}]},
        {"blocks": [{"type": "unknown"}]},
    ],
)
def test_invalid_layouts_fail_catalog_and_production(layout):
    assert not Draft202012Validator(LAYOUT_SCHEMA).is_valid(layout)
    with pytest.raises(ValidationError) as caught:
        validate_layout(layout)
    assert caught.value.code == "invalid_input"


@pytest.mark.parametrize("equals", [None, True, 1, 1.5, "reading"])
def test_computed_metric_schema_accepts_each_json_scalar(equals):
    validate_layout(
        {
            "blocks": [
                {
                    "type": "metric",
                    "label": "matching",
                    "collection": "books",
                    "count": True,
                    "where": {"field": "status", "equals": equals},
                }
            ]
        }
    )


@pytest.mark.parametrize(
    ("metric", "bad_value"),
    [
        (
            {
                "type": "metric",
                "label": "bad field",
                "collection": "books",
                "count": True,
                "where": {"field": 'status") OR 1=1 --', "equals": "reading"},
            },
            'status") OR 1=1 --',
        ),
        (
            {
                "type": "metric",
                "label": "bad equals",
                "collection": "books",
                "count": True,
                "where": {"field": "status", "equals": {"nested": True}},
            },
            {"nested": True},
        ),
        (
            {
                "type": "metric",
                "label": "extra",
                "collection": "books",
                "count": True,
                "extra": "secret",
            },
            "secret",
        ),
    ],
)
def test_computed_metric_schema_rejects_unsafe_input_without_echo(metric, bad_value):
    layout = {"blocks": [metric]}
    assert not Draft202012Validator(LAYOUT_SCHEMA).is_valid(layout)
    with pytest.raises(ValidationError) as caught:
        validate_layout(layout)
    error = error_document(caught.value)
    assert set(error) == {"code", "path", "expected"}
    assert json.dumps(bad_value) not in json.dumps(error)


def test_computed_metrics_count_records_at_read_time(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    layout = {
        "blocks": [
            {"type": "metric", "label": "all", "collection": "books", "count": True},
            {
                "type": "metric",
                "label": "reading",
                "collection": "books",
                "count": True,
                "where": {"field": "status", "equals": "reading"},
            },
            {"type": "metric", "label": "missing", "collection": "other", "count": True},
        ]
    }
    page, _, _ = store.create_page("/metrics", "metrics", layout)
    store.set_create_mode(page["id"], True)
    assert store.update_layout(page["id"], layout, 1)[0] == 2
    with store.transaction() as db:
        for index, document in enumerate(
            ({"status": "reading"}, {"status": "done"}, {"status": "reading"})
        ):
            db.execute(
                "INSERT INTO page_record(page_id,collection,record_id,version,document,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (page["id"], "books", str(index), 1, json.dumps(document), "now", "now"),
            )

    blocks = store.layout(page["id"])["blocks"]
    assert [block["value"] for block in blocks] == [3, 2, 0]
    inspected = store.inspect_page(page["id"])
    assert inspected["metric_values"] == [
        {"block": 0, "value": 3},
        {"block": 1, "value": 2},
        {"block": 2, "value": 0},
    ]


def test_inspected_computed_metric_layout_round_trips_to_update(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    layout = {
        "blocks": [{"type": "metric", "label": "books", "collection": "books", "count": True}]
    }
    page, _, _ = store.create_page("/metrics", "metrics", layout)
    store.set_create_mode(page["id"], True)

    inspected = store.inspect_page(page["id"])
    assert inspected["layout"] == layout
    assert store.update_layout(page["id"], inspected["layout"], inspected["layout_version"])[0] == 2


def test_computed_metric_equals_preserves_json_scalar_types(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    equals_values = [True, False, "1", 1, None]
    layout = {
        "blocks": [
            {
                "type": "metric",
                "label": str(value),
                "collection": "items",
                "count": True,
                "where": {"field": "value", "equals": value},
            }
            for value in equals_values
        ]
    }
    page, _, _ = store.create_page("/metrics", "metrics", layout)
    with store.transaction() as db:
        for index, document in enumerate(
            (
                {},
                {"value": None},
                {"value": True},
                {"value": 1},
                {"value": 1.0},
                {"value": "true"},
                {"value": False},
                {"value": 0},
                {"value": ""},
                {"value": "1"},
            )
        ):
            db.execute(
                "INSERT INTO page_record(page_id,collection,record_id,version,document,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (page["id"], "items", str(index), 1, json.dumps(document), "now", "now"),
            )

    assert [block["value"] for block in store.layout(page["id"])["blocks"]] == [
        1,
        1,
        1,
        2,
        2,
    ]


def test_create_page_schema_rejects_reserved_route_through_store(tmp_path):
    value = {"route": "/api/report", "title": "report", "layout": {"blocks": []}}
    assert not Draft202012Validator(CREATE_PAGE_SCHEMA).is_valid(value)
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    with pytest.raises(ValidationError) as caught:
        store.create_page(**value)
    assert caught.value.path == "/route"
    assert caught.value.expected.startswith("pattern ")


def test_layout_rejects_unknown_tool_reference() -> None:
    with pytest.raises(ValidationError) as caught:
        validate_layout({"blocks": [{"type": "form", "title": "x", "tool": "other"}]})
    assert caught.value.path == "/blocks/0/tool"
    assert caught.value.expected == "assigned tool name"


def test_create_page_commits_layout_and_audit(tmp_path) -> None:
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    page, digest, existing = store.create_page(
        "/reports", "reports", {"blocks": [{"type": "text", "text": "hello"}]}
    )
    assert page["route"] == "/reports"
    with store.transaction() as db:
        assert db.execute("SELECT digest FROM layout_version").fetchone()[0] == digest
        assert db.execute("SELECT action FROM audit").fetchone()[0] == "create_page"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()


def test_existing_page_session_is_copied_to_chat_once(tmp_path) -> None:
    database = tmp_path / "achilles.sqlite3"
    with sqlite3.connect(database) as db:
        db.execute(
            "CREATE TABLE page (id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, "
            "title TEXT NOT NULL, zeta_session_id TEXT, active_layout_version INTEGER, "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, "
            "create_mode INTEGER NOT NULL DEFAULT 0, credential_hash TEXT)"
        )
        db.execute(
            "INSERT INTO page VALUES (?,?,?,?,?,?,?,?,?)",
            (
                "existing",
                "/existing",
                "existing",
                "session-old",
                None,
                "created",
                "updated",
                0,
                None,
            ),
        )
        db.execute("PRAGMA user_version = 3")
    PageStore(tmp_path)
    PageStore(tmp_path)
    with sqlite3.connect(database) as db:
        assert db.execute(
            "SELECT session_id,page_id,created_at,updated_at FROM chat "
            "WHERE session_id='session-old'"
        ).fetchall() == [("session-old", "existing", "created", "updated")]


def test_update_layout_rejects_stale_and_unknown_tool_without_writes(tmp_path):
    store = PageStore(tmp_path)
    page_id = _update_page(store)
    with store._connect() as db:
        before = {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
            for table in ("page", "layout_version", "audit")
        }

    with pytest.raises(ValidationError) as stale:
        store.update_layout(page_id, {"blocks": []}, 2)
    assert (stale.value.code, stale.value.path, stale.value.expected) == (
        "conflict",
        "/expected_version",
        "current active layout version",
    )
    with pytest.raises(ValidationError) as unknown:
        store.update_layout(
            page_id,
            {"blocks": [{"type": "form", "title": "edit", "tool": "missing"}]},
            1,
        )
    assert (unknown.value.path, unknown.value.expected) == (
        "/layout/blocks/0/tool",
        "assigned tool name",
    )
    with store._connect() as db:
        after = {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
            for table in ("page", "layout_version", "audit")
        }
    assert after == before


def test_concurrent_layout_updates_have_one_winner(tmp_path):
    store = PageStore(tmp_path)
    page_id = _update_page(store)
    barrier = Barrier(2)

    def update(text):
        connection = PageStore(tmp_path)
        barrier.wait(timeout=10)
        try:
            return connection.update_layout(
                page_id, {"blocks": [{"type": "text", "text": text}]}, 1
            )
        except ValidationError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(update, ("first", "second")))
    winners = [outcome for outcome in outcomes if isinstance(outcome, tuple)]
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, ValidationError)]
    assert len(winners) == 1 and winners[0][0] == 2
    assert len(conflicts) == 1 and conflicts[0].code == "conflict"
    with store._connect() as db:
        assert (
            db.execute(
                "SELECT COUNT(*) FROM layout_version WHERE page_id=?", (page_id,)
            ).fetchone()[0]
            == 2
        )
        assert (
            db.execute(
                "SELECT COUNT(*) FROM audit WHERE page_id=? AND action='update_layout'", (page_id,)
            ).fetchone()[0]
            == 1
        )


def test_update_layout_preserves_records_tools_and_chats(tmp_path):
    store = PageStore(tmp_path)
    page_id = _update_page(store)
    store.register_chat(page_id, "synthetic-chat")
    call_record(store, page_id, "add_book", {"title": "one"}, 1)
    with store._connect() as db:
        before = {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
            for table in ("page_record", "tool", "tool_version", "page_tool", "chat")
        }
    layout = {"blocks": [{"type": "text", "text": "updated"}]}
    assert store.update_layout(page_id, layout, 1)[0] == 2
    assert store.layout(page_id) == layout
    assert store.inspect_page(page_id)["layout_version"] == 2
    with store._connect() as db:
        after = {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
            for table in ("page_record", "tool", "tool_version", "page_tool", "chat")
        }
    assert after == before


def test_null_active_layout_version_reads_version_one_not_latest(tmp_path):
    store = PageStore(tmp_path)
    page_id = _update_page(store)
    inactive = {"blocks": [{"type": "text", "text": "inactive"}]}
    with store.transaction() as db:
        db.execute("UPDATE page SET active_layout_version=NULL WHERE id=?", (page_id,))
        db.execute(
            "INSERT INTO layout_version VALUES(?,?,?,?,?)",
            (page_id, 2, "inactive", json.dumps(inactive), "later"),
        )
    assert store.layout(page_id)["blocks"][0]["type"] == "list"
    assert store.inspect_page(page_id)["layout_version"] == 1


def test_save_session_compare_and_set_has_one_winner(tmp_path):
    import threading

    for round_number in range(50):
        store = PageStore(tmp_path / str(round_number))
        barrier = threading.Barrier(2)
        results = []
        errors = []

        def save(session_id):
            try:
                barrier.wait(timeout=10)
                results.append((session_id, *store.save_session("home", None, session_id)))
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=save, args=(sid,)) for sid in ("a", "b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        assert not any(thread.is_alive() for thread in threads), "save_session thread hung"
        assert not errors
        assert sorted(result[1] for result in results) == [False, True]
        winner = next(result for result in results if result[1])
        assert all(result[2] == winner[0] for result in results)
        with store.transaction() as db:
            assert [tuple(row) for row in db.execute("SELECT session_id,page_id FROM chat")] == [
                (winner[0], "home")
            ]
