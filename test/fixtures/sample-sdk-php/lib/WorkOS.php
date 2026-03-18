<?php

namespace WorkOS;

class WorkOS
{
    /**
     * @var string|null
     */
    private static $apiKey;

    /**
     * @var string|null
     */
    private static $clientId;

    /**
     * Set the API key.
     *
     * @param string $apiKey
     *
     * @return void
     */
    public static function setApiKey($apiKey)
    {
        self::$apiKey = $apiKey;
    }

    /**
     * Get the API key.
     *
     * @return string|null
     */
    public static function getApiKey()
    {
        return self::$apiKey;
    }

    /**
     * Set the client ID.
     *
     * @param string $clientId
     *
     * @return void
     */
    public static function setClientId($clientId)
    {
        self::$clientId = $clientId;
    }

    /**
     * Get the client ID.
     *
     * @return string|null
     */
    public static function getClientId()
    {
        return self::$clientId;
    }
}
