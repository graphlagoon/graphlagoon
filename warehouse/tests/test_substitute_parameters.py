"""Named STRING parameters become Spark string literals."""

from src.routers.statements import StatementParameter, substitute_parameters


def test_quotes_and_backslashes_survive_spark_unescaping():
    sql = substitute_parameters(
        "SELECT :v", [StatementParameter(name="v", value='it\'s {"a": "x\\"y"}', type="STRING")]
    )
    # Spark unescapes \\ to \ and \' to ', giving back the value exactly.
    assert sql == "SELECT 'it\\'s {\"a\": \"x\\\\\"y\"}'"
