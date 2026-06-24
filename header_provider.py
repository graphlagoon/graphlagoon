import asyncio
import time

import httpx
from pydantic import BaseModel, computed_field


class OAuthToken(BaseModel):
    """Modelo para representar um token OAuth."""

    access_token: str
    expires_at: float

    @computed_field
    def is_expired(self) -> bool:
        """Verifica se o token expirou."""
        return time.time() >= self.expires_at

    @computed_field
    def authorization_header(self) -> str:
        """Retorna o cabeçalho de autorização."""
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
        """
        Obtém um token válido, renovando se necessário.

        Returns:
            Token de acesso válido
        """
        async with self._token_lock:

            if self.fallback_token:
                return f"Bearer {self.fallback_token}"

            if self._current_token and not self._current_token.is_expired:
                return self._current_token.authorization_header

            # Tenta obter um novo token via OAuth
            new_token = await self._fetch_oauth_token()
            self._current_token = new_token
            return new_token.authorization_header

    async def _fetch_oauth_token(self) -> OAuthToken:
        """
        Faz requisição assíncrona para obter um novo token OAuth.

        Returns:
            Novo token OAuth

        Raises:
            httpx.HTTPError: Se a requisição falhar
        """
        token_url = f"{self.workspace_url}/oidc/v1/token"

        data = {
            "grant_type": "client_credentials",
            "scope": "all-apis"
        }

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


from functools import lru_cache

from config import settings
from services.databricks_oauth_service import DatabricksOAuthService


@lru_cache()
def get_databricks_oauth_service() -> DatabricksOAuthService:
    return DatabricksOAuthService(
        workspace_url=os.getenv("DATABRICKS_HOST"),
        client_id=os.getenv("DATABRICKS_CLIENT_ID", ""),
        client_secret=os.getenv("DATABRICKS_CLIENT_SECRET", ""),
        fallback_token=None
    )


def get_oauth_service() -> DatabricksOAuthService:
    """Dependência FastAPI para o serviço de OAuth."""
    return get_databricks_oauth_service()


header_provider=get_oauth_service().get_token,
