<?php

namespace WorkOS\Resource;

class BaseWorkOSResource
{
    protected $values;

    public $raw;

    public static function constructFromResponse($response)
    {
        $resource = new static();
        $resource->raw = $response;
        return $resource;
    }

    public function toArray()
    {
        return $this->values;
    }
}
