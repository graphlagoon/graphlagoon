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
from graphlagoon.services.file_mapping_presets import PRESETS, QSA_RECEITA, SIMBA_V31

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


def test_presets_equal_fixture_specs_and_are_suggested():
    assert SIMBA_V31 == _load("simba-mini")[1]
    assert QSA_RECEITA == _load("qsa-mini")[1]
    assert suggest_presets(_load("simba-mini")[0], PRESETS) == ["simba_v31"]
    assert suggest_presets(_load("qsa-mini")[0], PRESETS) == ["qsa_receita"]
    assert suggest_presets(_load("generico")[0], PRESETS) == []


def test_unknown_operator_is_an_error():
    spec = _load("generico")[1]
    spec["nodes"][0]["id"] = {"col": "t.origem", "convert": "rot13"}
    with pytest.raises(MappingError, match="unknown convert"):
        validate(spec)
