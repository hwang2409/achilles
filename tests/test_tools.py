import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor, wait
from multiprocessing import get_context
from pathlib import Path
from threading import Barrier

import pytest
from jsonschema import Draft202012Validator

from achilles.pages import PageStore
from achilles.records import VersionConflict, call_record
from achilles.tools import CREATE_TOOL_SCHEMA, ValidationError, bundle_digest, validate_bundle


def _start_store(root: str, ready, start, outcomes) -> None:
    ready.put(True)
    if not start.wait(10):
        outcomes.put("startup gate timed out")
        return
    try:
        PageStore(Path(root))
    except Exception as exc:
        outcomes.put(repr(exc))
    else:
        outcomes.put(None)


BUNDLE = {
    "format_version": 1,
    "kind": "data_operation",
    "name": "annotate_trace",
    "description": "add an annotation",
    "input_schema": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    },
    "implementation": {
        "operation": "insert",
        "collection": "annotations",
        "data_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
}


@pytest.mark.parametrize("operation", ["list", "get", "insert", "update"])
def test_every_operation_matches_catalog_and_store(tmp_path, operation):
    bundle = {
        **BUNDLE,
        "name": f"{operation}_annotation",
        "input_schema": (
            {
                "type": "object",
                "properties": {
                    "record_id": {"type": "string"},
                    "revision": {"type": "integer"},
                    "text": {"type": "string"},
                },
                "required": ["record_id", "revision"],
                "additionalProperties": False,
            }
            if operation == "update"
            else BUNDLE["input_schema"]
        ),
        "implementation": {**BUNDLE["implementation"], "operation": operation},
    }
    assert Draft202012Validator(CREATE_TOOL_SCHEMA).is_valid({"bundle": bundle})
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    created, _ = store.create_tool("home", bundle)
    assert created["name"] == bundle["name"]
    output = store.page_tools("home")[0]["output_schema"]
    if operation == "list":
        assert output["type"] == "array"
        output = output["items"]
    elif operation == "get":
        assert output["anyOf"][1] == {"type": "null"}
        output = output["anyOf"][0]
    assert output["required"] == ["text", "record_id", "revision"]


def test_update_schema_requires_record_revision(tmp_path):
    bundle = {
        **BUNDLE,
        "name": "update_annotation",
        "implementation": {**BUNDLE["implementation"], "operation": "update"},
    }
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    with pytest.raises(ValidationError) as caught:
        store.create_tool("home", bundle)
    assert caught.value.path == "/input_schema"
    assert caught.value.expected == "required integer property: revision"


@pytest.mark.parametrize(
    "bundle",
    [
        {**BUNDLE, "implementation": {**BUNDLE["implementation"], "operation": "delete"}},
        {**BUNDLE, "implementation": {**BUNDLE["implementation"], "collection": "Not valid"}},
        {**BUNDLE, "name": "create_page"},
        {**BUNDLE, "extra": True},
    ],
)
def test_schema_expressible_bundle_errors_fail_catalog_and_store(tmp_path, bundle):
    assert not Draft202012Validator(CREATE_TOOL_SCHEMA).is_valid({"bundle": bundle})
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    with pytest.raises(ValidationError) as caught:
        store.create_tool("home", bundle)
    assert caught.value.code == "invalid_input"


@pytest.mark.parametrize(
    ("schema", "expected"),
    [
        ({"type": "not-a-real-type"}, "valid JSON Schema"),
        ({"description": "x" * 16_385}, "serialized size <= 16384 bytes"),
    ],
)
def test_nested_schema_semantics_fail_store_with_structured_error(tmp_path, schema, expected):
    bundle = {**BUNDLE, "implementation": {**BUNDLE["implementation"], "data_schema": schema}}
    assert Draft202012Validator(CREATE_TOOL_SCHEMA).is_valid({"bundle": bundle})
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    with pytest.raises(ValidationError) as caught:
        store.create_tool("home", bundle)
    assert caught.value.path == "/implementation/data_schema"
    assert caught.value.expected == expected


@pytest.mark.parametrize(
    "implementation",
    [
        {**BUNDLE["implementation"], "operation": "sk-secret-do-not-echo"},
        {**BUNDLE["implementation"], "collection": "/Users/henry/private/path"},
    ],
)
def test_structured_errors_never_echo_rejected_values(tmp_path, implementation):
    bundle = {**BUNDLE, "implementation": implementation}
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    with pytest.raises(ValidationError) as caught:
        store.create_tool("home", bundle)
    error = {
        "code": caught.value.code,
        "path": caught.value.path,
        "expected": caught.value.expected,
    }
    encoded = json.dumps(error)
    assert "sk-secret-do-not-echo" not in encoded
    assert "/Users/henry/private/path" not in encoded
    assert caught.value.path.startswith("/implementation/")


@pytest.mark.parametrize("extra_key", ["sk_secret_do_not_echo", "Users_henry_private_path"])
def test_additional_property_errors_never_echo_user_keys(tmp_path, extra_key):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    with pytest.raises(ValidationError) as caught:
        store.create_tool("home", {**BUNDLE, extra_key: True})
    error = {
        "code": caught.value.code,
        "path": caught.value.path,
        "expected": caught.value.expected,
    }
    assert extra_key not in json.dumps(error)
    assert caught.value.expected == (
        "only properties: format_version, kind, name, description, input_schema, output_schema, "
        "implementation"
    )


def test_sqlite_is_owned_by_pages_module():
    source_root = __import__("pathlib").Path(__file__).parents[1] / "src"
    offenders = [
        path
        for path in source_root.rglob("*.py")
        if path.name != "pages.py" and "import sqlite3" in path.read_text()
    ]
    assert not offenders, "keep sqlite3 ownership in src/achilles/pages.py"


def test_legacy_tool_uses_derived_output_schema_at_call_time(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    store.create_tool("home", BUNDLE)
    with store.transaction() as db:
        row = db.execute("SELECT tool_id, version, bundle FROM tool_version").fetchone()
        legacy = json.loads(row["bundle"])
        legacy["output_schema"] = {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        }
        stored_digest = bundle_digest(legacy)
        db.execute(
            "UPDATE tool_version SET digest=?, bundle=? WHERE tool_id=? AND version=?",
            (stored_digest, json.dumps(legacy), row["tool_id"], row["version"]),
        )

    result = call_record(store, "home", "annotate_trace", {"text": "legacy"}, 1)
    assert result["text"] == "legacy"
    assert result["record_id"]
    assert result["revision"] == 1
    with store.transaction() as db:
        audit_digest = db.execute(
            "SELECT version_digest FROM audit WHERE action='invoke:annotate_trace'"
        ).fetchone()["version_digest"]
    assert audit_digest == stored_digest


def test_generated_tool_versions_and_page_scope(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    created, _ = store.create_tool("home", BUNDLE)
    assert created["version"] == 1
    assert call_record(store, "home", "annotate_trace", {"text": "one"}, 1)["text"] == "one"
    with store._connect() as db:
        assert len(db.execute("SELECT * FROM page_record").fetchall()) == 1
    version_two = {
        **BUNDLE,
        "input_schema": {
            "type": "object",
            "properties": {"label": {"type": "string"}},
            "required": ["label"],
            "additionalProperties": False,
        },
    }
    updated, _ = store.create_tool("home", version_two)
    assert updated["version"] == 2
    store.rollback_tool("home", "annotate_trace", 1)
    assert store.page_tools("home")[0]["version"] == 1
    store.set_create_mode("home", False)
    assert call_record(store, "home", "annotate_trace", {"text": "late"}, 1)["text"] == "late"


def test_concurrent_record_and_page_writes_are_isolated(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    store.create_tool("home", BUNDLE)

    def write_record(index):
        return call_record(store, "home", "annotate_trace", {"text": str(index)}, 1)

    def write_page(index):
        return store.save_session(
            "home", None if index == 0 else f"session-{index - 1}", f"session-{index}"
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [
            pool.submit(operation, index)
            for operation, index in [(write_record, i) for i in range(20)]
            + [(write_page, i) for i in range(20)]
        ]
        done, pending = wait(futures, timeout=10)
        if pending:
            for future in pending:
                future.cancel()
            # sqlite's five-second busy timeout drains workers after a bounded wait.
            pool.shutdown(wait=True, cancel_futures=True)
            pytest.fail("concurrent operation exceeded 10-second deadline")
        outcomes = [future.exception() for future in done]
    assert not [error for error in outcomes if error], f"worker failed: {outcomes}"
    assert len(done) == 40, "expected 40 successful operations"
    with store._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 20

    store.set_create_mode("home", False)
    assert call_record(store, "home", "annotate_trace", {"text": "late"}, 1)["text"] == "late"
    with store._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 21


def test_existing_records_start_at_revision_one(tmp_path):
    tmp_path.mkdir(exist_ok=True)
    with sqlite3.connect(tmp_path / "achilles.sqlite3") as db:
        db.execute(
            """CREATE TABLE page_record (
            page_id TEXT NOT NULL, collection TEXT NOT NULL, record_id TEXT NOT NULL,
            version INTEGER NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY(page_id, collection, record_id))"""
        )
        db.execute(
            "INSERT INTO page_record VALUES(?,?,?,?,?,?,?)",
            ("home", "notes", "old", 1, '{"text":"old"}', "then", "then"),
        )
    store = PageStore(tmp_path)
    assert store.records("home", "notes")[0] == [{"text": "old", "record_id": "old", "revision": 1}]


def test_concurrent_startup_adds_revision_once(tmp_path):
    tmp_path.mkdir(exist_ok=True)
    database = tmp_path / "achilles.sqlite3"
    with sqlite3.connect(database) as db:
        db.execute(
            """CREATE TABLE page_record (
            page_id TEXT NOT NULL, collection TEXT NOT NULL, record_id TEXT NOT NULL,
            version INTEGER NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY(page_id, collection, record_id))"""
        )

    context = get_context("spawn")
    ready = context.Queue()
    start = context.Event()
    outcomes = context.Queue()
    processes = [
        context.Process(target=_start_store, args=(str(tmp_path), ready, start, outcomes))
        for _ in range(2)
    ]
    try:
        for process in processes:
            process.start()
        for _ in processes:
            ready.get(timeout=10)
        start.set()
        for process in processes:
            process.join(timeout=10)
        assert all(not process.is_alive() for process in processes), "startup process timed out"
        errors = [outcomes.get(timeout=10) for _ in processes]
        assert errors == [None, None], f"concurrent startup failed: {errors}"
        assert all(process.exitcode == 0 for process in processes)
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
            process.join(timeout=10)
        ready.close()
        outcomes.close()

    with sqlite3.connect(database) as db:
        columns = [row[1] for row in db.execute("PRAGMA table_info(page_record)")]
    assert columns.count("revision") == 1


def test_stale_record_revision_cannot_overwrite_or_audit(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    update_bundle = {
        **BUNDLE,
        "name": "update_annotation",
        "input_schema": {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"},
                "revision": {"type": "integer"},
                "text": {"type": "string"},
            },
            "required": ["record_id", "revision", "text"],
            "additionalProperties": False,
        },
        "implementation": {**BUNDLE["implementation"], "operation": "update"},
    }
    store.create_tool("home", BUNDLE)
    store.create_tool("home", update_bundle)
    call_record(store, "home", "annotate_trace", {"text": "first"}, 1)
    barrier = Barrier(2)

    def update(text):
        connection = PageStore(tmp_path)
        record = connection.records("home", "annotations")[0][0]
        barrier.wait(timeout=10)
        try:
            return call_record(
                connection,
                "home",
                "update_annotation",
                {"record_id": record["record_id"], "revision": record["revision"], "text": text},
                1,
            )
        except VersionConflict as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(update, ("second", "stale")))
    winners = [outcome for outcome in outcomes if isinstance(outcome, dict)]
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, VersionConflict)]
    assert len(winners) == 1 and winners[0]["revision"] == 2
    assert len(conflicts) == 1 and conflicts[0].code == "conflict"
    assert store.records("home", "annotations")[0][0]["text"] in {"second", "stale"}
    with store._connect() as db:
        assert (
            db.execute(
                "SELECT COUNT(*) FROM audit WHERE action='invoke:update_annotation'"
            ).fetchone()[0]
            == 1
        )


def test_reserved_bundle_names_are_rejected(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    for name in ("inspect_page", "create_page", "create_tool"):
        with pytest.raises(ValidationError, match="not one of"):
            store.create_tool("home", {**BUNDLE, "name": name})


def test_record_id_is_authoritative(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    bundle = {
        **BUNDLE,
        "input_schema": {
            **BUNDLE["input_schema"],
            "properties": {
                "text": {"type": "string"},
                "record_id": {"type": "string"},
            },
        },
        "implementation": {
            **BUNDLE["implementation"],
            "data_schema": {
                **BUNDLE["implementation"]["data_schema"],
                "properties": {
                    "text": {"type": "string"},
                    "record_id": {"type": "string"},
                },
            },
        },
    }
    store.create_tool("home", bundle)
    result = call_record(store, "home", "annotate_trace", {"text": "x", "record_id": "forged"}, 1)
    assert result["record_id"] != "forged"
    second = call_record(store, "home", "annotate_trace", {"text": "y", "record_id": "forged"}, 1)
    assert second["record_id"] != "forged"


def test_bundle_publish_cleans_stale_temp(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    digest = bundle_digest(validate_bundle(BUNDLE))
    (tmp_path / "bundles" / f"{digest}.tmp").write_text("stale")
    error = None
    try:
        store.create_tool("home", BUNDLE)
    except Exception as exc:  # assert the old failure at a behavior boundary
        error = exc
    assert error is None, f"bundle publication failed: {error}"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()


def test_bundle_is_canonical_and_private(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    _, digest = store.create_tool("home", BUNDLE)
    path = tmp_path / "bundles" / f"{digest}.json"
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["name"] == "annotate_trace"
