from typing import Literal, Optional, Sequence
from workos.types.workos_model import WorkOSModel


class OrganizationCommon(WorkOSModel):
    id: str
    object: Literal["organization"]
    name: str
    created_at: str
    updated_at: str
