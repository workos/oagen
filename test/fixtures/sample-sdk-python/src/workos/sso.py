from typing import Optional, Protocol
from workos.types.sso.connection import Connection
from workos.types.sso.profile import Profile


class SSOModule(Protocol):
    def get_connection(self, connection_id: str) -> Connection: ...

    def list_connections(
        self,
        *,
        connection_type: Optional[str] = None,
        organization_id: Optional[str] = None,
        limit: int = 10,
    ) -> list: ...

    def get_profile(self, access_token: str) -> Profile: ...
