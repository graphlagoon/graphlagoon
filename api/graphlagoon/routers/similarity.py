"""Similarity router - catalog of registered similarity endpoints.

The parent app owns the actual compute endpoints. This router only
serves discovery so the frontend knows what's available.
"""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from graphlagoon.similarity import get_registered_endpoints

router = APIRouter(prefix="/api/similarity", tags=["similarity"])


class EndpointParamSchema(BaseModel):
    name: str
    type: str
    default: Any = None
    required: bool = False
    description: str = ""
    choices: list[str] | None = None


class EndpointSchema(BaseModel):
    name: str
    description: str
    endpoint: str
    params: list[EndpointParamSchema]


@router.get("/endpoints", response_model=list[EndpointSchema])
async def list_endpoints():
    """Return all registered similarity endpoint specs."""
    endpoints = get_registered_endpoints()
    return [
        EndpointSchema(
            name=ep.name,
            description=ep.description,
            endpoint=ep.endpoint,
            params=[
                EndpointParamSchema(
                    name=p.name,
                    type=p.type,
                    default=p.default,
                    required=p.required,
                    description=p.description,
                    choices=p.choices,
                )
                for p in ep.params
            ],
        )
        for ep in endpoints
    ]
