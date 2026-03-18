from typing import Optional
from workos.types.workos_model import WorkOSModel


class Profile(WorkOSModel):
    id: str
    email: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    connection_id: str
    connection_type: str
    organization_id: Optional[str] = None
    idp_id: str
