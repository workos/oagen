<?php

namespace WorkOS\RequestClient;

interface RequestClientInterface
{
    /**
     * Make a request.
     *
     * @param string $method
     * @param string $path
     * @param null|array $headers
     * @param null|array $params
     *
     * @return array
     */
    public function request($method, $path, $headers = null, $params = null);
}
