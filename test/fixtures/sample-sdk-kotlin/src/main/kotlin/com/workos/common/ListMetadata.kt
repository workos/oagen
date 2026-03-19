package com.workos.common

import com.fasterxml.jackson.annotation.JsonProperty

data class ListMetadata(
    @JsonProperty("before")
    val before: String? = null,

    @JsonProperty("after")
    val after: String? = null
)
