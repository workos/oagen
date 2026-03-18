from typing import Optional, Sequence
from workos.types.organizations.organization_common import OrganizationCommon


class Organization(OrganizationCommon):
    allow_profiles_outside_organization: bool
    domains: Sequence[str]
    stripe_customer_id: Optional[str] = None
