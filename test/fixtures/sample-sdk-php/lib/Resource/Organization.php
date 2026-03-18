<?php

namespace WorkOS\Resource;

class Organization extends BaseWorkOSResource
{
    const RESOURCE_ATTRIBUTES = [
        "id",
        "name",
        "allowProfilesOutsideOrganization",
        "domains"
    ];

    const RESPONSE_TO_RESOURCE_KEY = [
        "id" => "id",
        "name" => "name",
        "allow_profiles_outside_organization" => "allowProfilesOutsideOrganization",
        "domains" => "domains"
    ];
}
