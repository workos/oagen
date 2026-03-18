<?php

namespace WorkOS;

class SSO
{
    /**
     * Get an authorization URL.
     *
     * @param string $domain
     * @param string $redirectUri
     * @param null|array $state
     * @param null|string $provider
     * @param null|string $connectionId
     * @param null|string $organizationId
     *
     * @return string
     */
    public function getAuthorizationUrl($domain, $redirectUri, $state = null, $provider = null, $connectionId = null, $organizationId = null)
    {
        // implementation
    }

    /**
     * Get a profile and token.
     *
     * @param string $code
     *
     * @return \WorkOS\Resource\Profile
     */
    public function getProfileAndToken($code)
    {
        // implementation
    }

    /**
     * Get a connection.
     *
     * @param string $connectionId
     *
     * @return \WorkOS\Resource\Connection
     */
    public function getConnection($connectionId)
    {
        // implementation
    }

    /**
     * List connections.
     *
     * @param null|string $connectionType
     * @param null|string $domain
     * @param null|string $organizationId
     * @param int $limit
     * @param null|string $before
     * @param null|string $after
     *
     * @return array
     */
    public function listConnections($connectionType = null, $domain = null, $organizationId = null, $limit = 10, $before = null, $after = null)
    {
        // implementation
    }
}
