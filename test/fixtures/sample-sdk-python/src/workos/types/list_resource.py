from typing import Generic, TypeVar, Optional
from workos.types.workos_model import WorkOSModel

T = TypeVar("T")
F = TypeVar("F")
M = TypeVar("M")


class ListMetadata(WorkOSModel):
    before: Optional[str] = None
    after: Optional[str] = None


class ListPage(WorkOSModel):
    data: list
    list_metadata: ListMetadata


class WorkOSListResource(Generic[T, F, M]):
    pass
