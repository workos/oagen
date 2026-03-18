<?php

namespace WorkOS\Resource;

class Connection extends BaseWorkOSResource
{
    const RESOURCE_ATTRIBUTES = [
        "id",
        "connectionType",
        "name",
        "state",
        "organizationId"
    ];

    const RESPONSE_TO_RESOURCE_KEY = [
        "id" => "id",
        "connection_type" => "connectionType",
        "name" => "name",
        "state" => "state",
        "organization_id" => "organizationId"
    ];
}
