use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Status {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "inactive")]
    Inactive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionType {
    #[serde(rename = "GenericSAML")]
    GenericSaml,
    #[serde(rename = "GenericOIDC")]
    GenericOidc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Order {
    #[serde(rename = "asc")]
    Asc,
    #[serde(rename = "desc")]
    Desc,
}

// Private enum — should not appear
#[derive(Debug)]
enum InternalState {
    Pending,
    Complete,
}
