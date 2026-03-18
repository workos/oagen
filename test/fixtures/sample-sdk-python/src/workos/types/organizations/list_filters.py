from typing import Optional, TypedDict, Required


class OrganizationListFilters(TypedDict, total=False):
    domains: Optional[list]
    before: Optional[str]
    after: Optional[str]
    limit: Required[int]
