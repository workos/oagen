from typing import Optional, Protocol, Sequence
from workos.types.organizations import Organization
from workos.types.list_resource import ListMetadata

OrganizationsListResource = "WorkOSListResource[Organization, OrganizationListFilters, ListMetadata]"


class OrganizationsModule(Protocol):
    def list_organizations(
        self,
        *,
        domains: Optional[Sequence[str]] = None,
        limit: int = 10,
        before: Optional[str] = None,
        after: Optional[str] = None,
    ) -> "OrganizationsListResource": ...

    def get_organization(self, organization_id: str) -> Organization: ...

    def create_organization(
        self, *, name: str, domains: Optional[Sequence[str]] = None
    ) -> Organization: ...

    def delete_organization(self, organization_id: str) -> None: ...

    def _internal_helper(self) -> None: ...
