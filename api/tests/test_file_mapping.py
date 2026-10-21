"""File mapping interpreter (F2.4): parity with the TS preview through the
golden fixtures in frontend/src/__tests__/fixtures/fileMapping/."""

import json
from pathlib import Path

import pytest

from graphlagoon.services.file_mapping import (
    MappingError,
    interpret,
    suggest_presets,
    validate,
)

ROOT = (
    Path(__file__).resolve().parents[2]
    / "frontend/src/__tests__/fixtures/fileMapping"
)
if not ROOT.is_dir():
    pytest.skip("frontend fixtures not checked out", allow_module_level=True)


def _load(name):
    case = ROOT / name
    files = {p.name: p.read_text() for p in case.iterdir() if p.suffix != ".json"}
    spec = json.loads((case / "spec.json").read_text())
    return files, spec, json.loads((case / "expected.json").read_text())


@pytest.mark.parametrize("name", sorted(p.name for p in ROOT.iterdir() if p.is_dir()))
def test_golden_fixture(name):
    files, spec, expected = _load(name)
    assert interpret(spec, files) == expected


def test_a_spec_is_suggested_when_its_inputs_match_the_files():
    specs = {name: _load(name)[1] for name in ("bank-statements", "company-registry")}
    assert suggest_presets(_load("bank-statements")[0], specs) == ["bank-statements"]
    assert suggest_presets(_load("generic")[0], specs) == []


def test_fixed_width_inputs_are_checked():
    spec = _load("fixed-width")[1]
    inp = spec["inputs"]["s"]
    for bad, message in (
        ({**inp, "delimiter": ";"}, "not both"),
        ({**inp, "widths": [8, 0]}, "positive integers"),
        ({**inp, "widths": [8, 10]}, "one width per column"),
    ):
        with pytest.raises(MappingError, match=message):
            validate({**spec, "inputs": {"s": bad}})
    # A fixed-width layout without a header is suggested when its lines reach the last column.
    assert suggest_presets(_load("fixed-width")[0], {"settlement": spec}) == ["settlement"]
    assert suggest_presets({"SETTLEMENT_1.TXT": "M0001234\n"}, {"settlement": spec}) == []


def test_unknown_operator_is_an_error():
    spec = _load("generic")[1]
    spec["nodes"][0]["id"] = {"col": "t.origem", "convert": "rot13"}
    with pytest.raises(MappingError, match="unknown convert"):
        validate(spec)
