<?php

namespace WorkOS;

class Organizations
{
    /**
     * List organizations.
     *
     * @param null|array $domains
     * @param int $limit
     * @param null|string $before
     * @param null|string $after
     *
     * @return array
     */
    public function listOrganizations($domains = null, $limit = 10, $before = null, $after = null)
    {
        // implementation
    }

    /**
     * Create an organization.
     *
     * @param string $name
     * @param array $domains
     * @param null|boolean $allowProfilesOutsideOrganization
     *
     * @return \WorkOS\Resource\Organization
     */
    public function createOrganization($name, $domains, $allowProfilesOutsideOrganization = null)
    {
        // implementation
    }

    /**
     * Get an organization.
     *
     * @param string $organization
     *
     * @return \WorkOS\Resource\Organization
     */
    public function getOrganization($organization)
    {
        // implementation
    }

    /**
     * Delete an organization.
     *
     * @param string $organization
     *
     * @return \WorkOS\Resource\Response
     */
    public function deleteOrganization($organization)
    {
        // implementation
    }

    private function internalHelper()
    {
        // private helper
    }
}
