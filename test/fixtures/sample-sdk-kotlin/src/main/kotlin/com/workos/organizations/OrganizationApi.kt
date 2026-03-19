package com.workos.organizations

import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonValue
import com.workos.common.ListMetadata

// Enum class for organization status
enum class Status(@JsonValue val value: String) {
    Active("active"),
    Inactive("inactive")
}

// Enum class for ordering
enum class Order(@JsonValue val value: String) {
    Asc("asc"),
    Desc("desc")
}

// Data class representing an Organization
data class Organization(
    @JsonProperty("id")
    val id: String,

    @JsonProperty("name")
    val name: String,

    @JsonProperty("status")
    val status: Status,

    @JsonProperty("allow_profiles_outside_organization")
    val allowProfilesOutsideOrganization: Boolean,

    @JsonProperty("domains")
    val domains: List<String>? = null,

    @JsonProperty("created_at")
    val createdAt: String,

    @JsonProperty("updated_at")
    val updatedAt: String
)

// Options for getting an organization
data class GetOrganizationOptions(
    val organization: String
)

// Options for listing organizations
data class ListOrganizationsOptions(
    val limit: Int? = null,
    val order: Order? = null,
    val after: String? = null
)

// Response for listing organizations
data class ListOrganizationsResponse(
    @JsonProperty("data")
    val data: List<Organization>,

    @JsonProperty("list_metadata")
    val listMetadata: ListMetadata
)

// Options for creating an organization
data class CreateOrganizationOptions(
    @JsonProperty("name")
    val name: String,

    @JsonProperty("domains")
    val domains: List<String>? = null
)

// Type alias for Status
typealias StatusAlias = Status

// Organization API service class
class OrganizationApi(private val workos: Any) {
    fun getOrganization(options: GetOrganizationOptions): Organization {
        TODO()
    }

    fun listOrganizations(options: ListOrganizationsOptions?): ListOrganizationsResponse {
        TODO()
    }

    fun createOrganization(options: CreateOrganizationOptions): Organization {
        TODO()
    }

    fun deleteOrganization(id: String): Unit {
        TODO()
    }

    // Private method — should not appear
    private fun internalHelper() {}
}
