package com.workos.sso

import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.annotation.JsonValue

// Enum class for connection type
enum class ConnectionType(@JsonValue val value: String) {
    GenericOIDC("GenericOIDC"),
    GenericSAML("GenericSAML")
}

// Data class representing a Connection
data class Connection(
    @JsonProperty("id")
    val id: String,

    @JsonProperty("organization_id")
    val organizationId: String,

    @JsonProperty("connection_type")
    val connectionType: String,

    @JsonProperty("name")
    val name: String,

    @JsonProperty("state")
    val state: String
)

// Data class representing a Profile
data class Profile(
    @JsonProperty("id")
    val id: String,

    @JsonProperty("email")
    val email: String,

    @JsonProperty("first_name")
    val firstName: String? = null,

    @JsonProperty("last_name")
    val lastName: String? = null,

    @JsonProperty("connection_id")
    val connectionId: String,

    @JsonProperty("organization_id")
    val organizationId: String
)

// SSO API service class
class SsoApi(private val workos: Any) {
    fun getConnection(id: String): Connection {
        TODO()
    }

    fun getProfile(token: String): Profile {
        TODO()
    }
}
