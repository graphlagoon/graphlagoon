"""Databricks OAuth M2M token provider.

Provides a ready-to-use ``header_provider`` for ``create_mountable_app``::

    from graphlagoon import create_mountable_app, get_oauth_service

    app.mount("/graphlagoon", create_mountable_app(
        header_provider=get_oauth_service().get_token,
        databricks_catalog="my_catalog",
        databricks_schema="my_schema",
    ))

Credentials are read natively from the Databricks App environment:
``DATABRICKS_HOST``, ``DATABRICKS_CLIENT_ID``, ``DATABRICKS_CLIENT_SECRET``.
"""

import asyncio
import os
import time
from functools import lru_cache

import httpx
from pydantic import BaseModel, computed_field


class OAuthToken(BaseModel):
    """Represents a Databricks OAuth access token with expiry tracking."""

    access_token: str
    expires_at: float

    @computed_field
    def is_expired(self) -> bool:
        """Returns True if the token has expired."""
        return time.time() >= self.expires_at

    @computed_field
    def authorization_header(self) -> str:
        """Returns the Authorization header value."""
        return f"Bearer {self.access_token}"


class DatabricksOAuthService:
    def __init__(
        self,
        workspace_url: str,
        client_id: str,
        client_secret: str,
        fallback_token: str | None = None,
    ):
        self.workspace_url = workspace_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.fallback_token = fallback_token
        self._current_token: OAuthToken | None = None
        self._token_lock = asyncio.Lock()

    async def get_token(self) -> str:
        """Return a valid token, refreshing it if expired.

        Returns:
            Bearer token string
        """
        async with self._token_lock:
            if self.fallback_token:
                return f"Bearer {self.fallback_token}"

            if self._current_token and not self._current_token.is_expired:
                return self._current_token.authorization_header

            # Fetch a new token via OAuth
            new_token = await self._fetch_oauth_token()
            self._current_token = new_token
            return new_token.authorization_header

    async def _fetch_oauth_token(self) -> OAuthToken:
        """Perform the OAuth client_credentials exchange and return a new token.

        Returns:
            New OAuthToken with expiry set 5 minutes before the server-reported value.

        Raises:
            httpx.HTTPError: If the token request fails.
        """
        token_url = f"{self.workspace_url}/oidc/v1/token"

        data = {"grant_type": "client_credentials", "scope": "all-apis"}

        auth = (self.client_id, self.client_secret)

        async with httpx.AsyncClient(verify=False) as client:
            response = await client.post(
                token_url,
                data=data,
                auth=auth,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

        response.raise_for_status()

        token_data = response.json()

        expires_in = token_data.get("expires_in", 3600)
        expires_at = time.time() + expires_in - 300

        return OAuthToken(
            access_token=token_data["access_token"],
            expires_at=expires_at,
        )

    async def refresh_token(self) -> str:
        async with self._token_lock:
            self._current_token = None
            return await self.get_token()


@lru_cache()
def get_databricks_oauth_service() -> DatabricksOAuthService:
    return DatabricksOAuthService(
        workspace_url=os.getenv("DATABRICKS_HOST"),
        client_id=os.getenv("DATABRICKS_CLIENT_ID", ""),
        client_secret=os.getenv("DATABRICKS_CLIENT_SECRET", ""),
        fallback_token=None,
    )


def get_oauth_service() -> DatabricksOAuthService:
    """Return the cached DatabricksOAuthService singleton."""
    return get_databricks_oauth_service()
