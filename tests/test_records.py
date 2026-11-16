import json

import pytest

from achilles.pages import PageStore
from achilles.records import LIST_LIMIT, call_record
from achilles.validation import ValidationError


def _bundle(name, operation, input_schema, data_schema):
    return {
        "format_version": 1,
        "kind": "data_operation",
        "name": name,
        "description": f"{operation} tasks",
        "input_schema": input_schema,
        "implementation": {
            "operation": operation,
            "collection": "tasks",
            "data_schema": data_schema,
        },
    }


TASK_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "status": {"type": "string"}},
    "additionalProperties": True,
}


@pytest.fixture
def store(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    # the eval harness list tool shape: no properties, additionalProperties false
    store.create_tool(
        "home",
        _bundle(
            "list_tasks", "list", {"type": "object", "additionalProperties": False}, TASK_SCHEMA
        ),
    )
    store.create_tool("home", _bundle("add_task", "insert", {"type": "object"}, TASK_SCHEMA))
    return store


def _add(store, **document):
    return call_record(store, "home", "add_task", document, 1, "agent")


def _list(store, **arguments):
    return call_record(store, "home", "list_tasks", arguments, 1, "agent")


def test_where_returns_only_matches_newest_first(store):
    _add(store, title="a", status="done")
    _add(store, title="b", status="open")
    _add(store, title="c", status="done")
    _add(store, title="d", extra=1)

    assert [r["title"] for r in _list(store)] == ["d", "c", "b", "a"]
    done = _list(store, where={"field": "status", "equals": "done"})
    assert [r["title"] for r in done] == ["c", "a"]
    assert _list(store, where={"field": "status", "equals": "missing"}) == []
    # null matches a missing field, as in the layout filter
    assert [r["title"] for r in _list(store, where={"field": "status", "equals": None})] == ["d"]
    # a field that only exists on stored records of a free-form collection is accepted
    assert [r["title"] for r in _list(store, where={"field": "extra", "equals": 1})] == ["d"]


def test_limit_caps_and_default_is_newest_500(store):
    with store.transaction() as db:
        db.executemany(
            "INSERT INTO page_record(page_id,collection,record_id,version,revision,document,"
            "created_at,updated_at) VALUES('home','tasks',?,1,1,?,?,?)",
            [
                (
                    f"r{index:04d}",
                    json.dumps({"title": str(index)}),
                    f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z",
                    "2026-01-01T00:00:00Z",
                )
                for index in range(LIST_LIMIT + 1)
            ],
        )

    everything = _list(store)
    assert len(everything) == LIST_LIMIT
    assert everything[0]["title"] == str(LIST_LIMIT)
    assert everything[-1]["title"] == "1"  # the oldest record falls off
    assert [r["title"] for r in _list(store, limit=2)] == [str(LIST_LIMIT), str(LIST_LIMIT - 1)]
    for limit in (0, LIST_LIMIT + 1, "5"):
        with pytest.raises(ValidationError) as error:
            _list(store, limit=limit)
        assert error.value.path == "/limit"


def test_unknown_field_is_validation_error_with_hint(store):
    _add(store, title="a", status="done")

    with pytest.raises(ValidationError) as error:
        _list(store, where={"field": "state", "equals": "done"})
    assert error.value.path == "/where/field"
    assert error.value.hint == (
        "Use a field from the tasks collection schema. Unknown field: state. "
        "Fields: record_id, status, title. Did you mean status?"
    )


def test_where_record_id_matches_one_record_exactly(store):
    first = _add(store, title="a", status="done")
    _add(store, title="b", status="open")

    matched = _list(store, where={"field": "record_id", "equals": first["record_id"]})
    assert [r["title"] for r in matched] == ["a"]
    assert _list(store, where={"field": "record_id", "equals": "missing"}) == []


@pytest.mark.parametrize(
    "field",
    ['status" OR 1=1 --', "status') OR 1=1 --", "$.status", "Status", "a" * 65],
)
def test_field_outside_name_pattern_is_rejected(store, field):
    _add(store, title="a", status="done")
    with pytest.raises(ValidationError) as error:
        _list(store, where={"field": field, "equals": "done"})
    assert error.value.path == "/where/field"


def test_equals_value_is_bound_not_interpolated(store):
    _add(store, title="a", status="done")
    _add(store, title="o'brien", status="open")

    assert _list(store, where={"field": "title", "equals": "x' OR '1'='1"}) == []
    assert [r["title"] for r in _list(store, where={"field": "title", "equals": "o'brien"})] == [
        "o'brien"
    ]
    with pytest.raises(ValidationError):
        _list(store, where={"field": "status", "equals": {"$ne": None}})


def test_multiple_of_cents_is_checked_exactly(store):
    # regression: float math made 19.99 % 0.01 != 0, so valid cent amounts were rejected
    amount = {"type": "number", "multipleOf": 0.01}
    expense = {"type": "object", "properties": {"amount": amount}, "required": ["amount"]}
    store.create_tool("home", _bundle("add_expense", "insert", expense, expense))

    def add(value):
        return call_record(store, "home", "add_expense", {"amount": value}, 1, "agent")

    for value in (19.99, 0.07, 12.5, 3, 1e30):
        assert add(value)["amount"] == value
    with pytest.raises(ValidationError) as error:
        add(19.995)
    assert error.value.path == "/amount"

    count = {"type": "object", "properties": {"n": {"type": "integer", "multipleOf": 3}}}
    store.create_tool("home", _bundle("add_count", "insert", count, count))
    assert call_record(store, "home", "add_count", {"n": 9}, 1, "agent")["n"] == 9
    with pytest.raises(ValidationError):
        call_record(store, "home", "add_count", {"n": 10}, 1, "agent")
