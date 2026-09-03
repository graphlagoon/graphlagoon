"""Test-suite-wide safety net.

The warehouse client is a module-level singleton: the first test to build one
against the real settings leaves ``http://localhost:8001`` cached for the whole
pytest process. A later test that clears the environment
(``POST /api/admin/environment/clear`` → ``DELETE /dev/clear-all``) then DROPs
every table in the developer's *running* ``make dev`` warehouse — contexts stay
in PostgreSQL, their tables do not, and every query afterwards fails with
``TABLE_OR_VIEW_NOT_FOUND``.

Nothing in the suite needs a live warehouse; the tests that need one stub it.
So point the client at the discard port and drop the singleton around every
test, and a wrong turn can only ever fail to connect.
"""

import pytest

from graphlagoon.config import get_settings
from graphlagoon.services import warehouse as warehouse_module

# RFC 863 discard port: nothing listens, so a stray call fails immediately
# instead of reaching a warehouse someone is using.
UNREACHABLE_WAREHOUSE = "http://127.0.0.1:9"


@pytest.fixture(autouse=True)
def never_touch_a_live_warehouse(monkeypatch):
    monkeypatch.setenv("GRAPH_LAGOON_SQL_WAREHOUSE_URL", UNREACHABLE_WAREHOUSE)
    get_settings.cache_clear()
    warehouse_module._warehouse_client = None
    yield
    warehouse_module._warehouse_client = None
    get_settings.cache_clear()
