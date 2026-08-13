"""HTTP client for Amazon Neptune's openCypher endpoint.

Mirrors ``services/warehouse.py``'s shape — a long-lived httpx client owned by
the datasource — but speaks Neptune's much smaller API: one POST to run a
query, plus a status endpoint used for best-effort cancellation and a summary
endpoint used for label discovery.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# Neptune reports failures as {"requestId", "code", "detailedMessage"}. These
# are the codes worth distinguishing to the user; everything else collapses to
# a generic execution error.
MALFORMED_QUERY_CODES = {
    "MalformedQueryException",
    "InvalidParameterException",
    "UnsupportedOperationException",
}


class NeptuneQueryError(Exception):
    """A failure Neptune reported about a query."""

    def __init__(
        self,
        message: str,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        status_code: Optional[int] = None,
    ):
        self.message = message
        self.neptune_code = code
        self.request_id = request_id
        self.status_code = status_code
        super().__init__(message)

    @property
    def is_malformed_query(self) -> bool:
        return self.neptune_code in MALFORMED_QUERY_CODES


class NeptuneClient:
    """Talks openCypher to a Neptune cluster over HTTPS."""

    def __init__(
        self,
        base_url: str,
        *,
        use_iam: bool = False,
        region: Optional[str] = None,
        verify_tls: bool = True,
        timeout: float = 120.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.use_iam = use_iam
        self.region = region
        self._timeout = timeout
        self._client = httpx.AsyncClient(verify=verify_tls, timeout=timeout)
        self._signer = _SigV4Signer(region) if use_iam else None

    async def close(self) -> None:
        await self._client.aclose()

    # ── Requests ─────────────────────────────────────────────────────────

    async def _post(self, path: str, payload: dict, *, form: bool = False):
        url = f"{self.base_url}{path}"
        if form:
            # The status endpoint takes form-encoded parameters, not JSON.
            body = httpx.QueryParams(payload).__str__().encode()
            headers = {"Content-Type": "application/x-www-form-urlencoded"}
        else:
            # Serialize once and send the exact bytes: SigV4 signs a hash of the
            # payload, so re-encoding between signing and sending would break
            # the signature.
            body = json.dumps(payload).encode()
            headers = {"Content-Type": "application/json"}

        if self._signer is not None:
            headers = self._signer.sign("POST", url, body, headers)

        response = await self._client.post(url, content=body, headers=headers)
        return self._parse(response)

    async def _get(self, path: str, params: Optional[dict] = None):
        url = f"{self.base_url}{path}"
        request = self._client.build_request("GET", url, params=params)
        headers = dict(request.headers)
        if self._signer is not None:
            headers = self._signer.sign("GET", str(request.url), b"", headers)
        response = await self._client.get(url, params=params, headers=headers)
        return self._parse(response)

    @staticmethod
    def _parse(response: httpx.Response) -> dict:
        try:
            payload = response.json()
        except Exception:
            payload = None

        if response.status_code >= 400:
            if isinstance(payload, dict):
                raise NeptuneQueryError(
                    payload.get("detailedMessage")
                    or payload.get("message")
                    or response.text,
                    code=payload.get("code"),
                    request_id=payload.get("requestId"),
                    status_code=response.status_code,
                )
            raise NeptuneQueryError(
                response.text or f"Neptune returned HTTP {response.status_code}",
                status_code=response.status_code,
            )

        if not isinstance(payload, dict):
            raise NeptuneQueryError(
                "Neptune returned a non-JSON response",
                status_code=response.status_code,
            )
        return payload

    # ── openCypher ───────────────────────────────────────────────────────

    async def execute_opencypher(
        self, query: str, parameters: Optional[dict] = None
    ) -> list[dict]:
        """Run a query and return its ``results`` rows."""
        payload: dict[str, Any] = {"query": query}
        if parameters:
            # Neptune expects the parameter map as a JSON *string* in the body.
            payload["parameters"] = json.dumps(parameters)

        response = await self._post("/openCypher", payload)
        results = response.get("results")
        return results if isinstance(results, list) else []

    async def list_query_status(self) -> list[dict]:
        """List currently running openCypher queries."""
        response = await self._get("/openCypher/status")
        queries = response.get("queries")
        return queries if isinstance(queries, list) else []

    async def cancel_query(self, query_id: str) -> None:
        """Best-effort cancel of a running query by its Neptune queryId."""
        await self._post(
            "/openCypher/status",
            {"cancelQuery": "true", "queryId": query_id},
            form=True,
        )

    async def get_summary(self) -> Optional[dict]:
        """Fetch the property-graph summary (labels + counts), if available.

        Returns None when the cluster has DFE statistics disabled, which is a
        normal configuration rather than an error — the caller falls back to
        sampling.
        """
        try:
            response = await self._get("/pg/statistics/summary", {"mode": "basic"})
        except NeptuneQueryError as e:
            logger.debug(f"Neptune summary unavailable: {e}")
            return None
        payload = response.get("payload") or response
        summary = payload.get("graphSummary") if isinstance(payload, dict) else None
        return summary if isinstance(summary, dict) else None


class _SigV4Signer:
    """Signs requests with AWS SigV4 for IAM-auth-enabled clusters.

    botocore is an optional dependency (the ``neptune-iam`` extra) because most
    deployments reach Neptune inside a VPC without IAM auth; importing it here
    keeps that install lean and fails loudly only when signing is actually
    requested.
    """

    SERVICE = "neptune-db"

    def __init__(self, region: Optional[str]):
        if not region:
            raise ValueError("neptune_region is required when neptune_use_iam=True")
        try:
            from botocore.auth import SigV4Auth  # noqa: F401
            from botocore.session import Session
        except ImportError as e:
            raise ValueError(
                "botocore is required for GRAPH_LAGOON_NEPTUNE_USE_IAM=true. "
                "Install the 'neptune-iam' extra."
            ) from e

        self.region = region
        self._credentials = Session().get_credentials()
        if self._credentials is None:
            raise ValueError(
                "No AWS credentials found for Neptune SigV4 signing. Configure "
                "the standard AWS credential chain (env, profile, or role)."
            )

    def sign(self, method: str, url: str, body: bytes, headers: dict) -> dict:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        request = AWSRequest(method=method, url=url, data=body, headers=dict(headers))
        SigV4Auth(self._credentials, self.SERVICE, self.region).add_auth(request)
        return dict(request.headers)
