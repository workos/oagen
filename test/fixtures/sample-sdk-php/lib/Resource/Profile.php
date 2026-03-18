<?php

namespace WorkOS\Resource;

class Profile extends BaseWorkOSResource
{
    const RESOURCE_ATTRIBUTES = [
        "id",
        "email",
        "firstName",
        "lastName",
        "connectionId",
        "connectionType",
        "idpId",
        "organizationId",
        "rawAttributes"
    ];

    const RESPONSE_TO_RESOURCE_KEY = [
        "id" => "id",
        "email" => "email",
        "first_name" => "firstName",
        "last_name" => "lastName",
        "connection_id" => "connectionId",
        "connection_type" => "connectionType",
        "idp_id" => "idpId",
        "organization_id" => "organizationId",
        "raw_attributes" => "rawAttributes"
    ];
}
