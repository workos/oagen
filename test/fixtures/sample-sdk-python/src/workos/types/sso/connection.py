from typing import Optional
from workos.types.workos_model import WorkOSModel


class Connection(WorkOSModel):
    id: str
    connection_type: str
    name: str
    state: str
    created_at: str
    updated_at: str
    organization_id: Optional[str] = None
