use crate::models::{Connection, Organization, Profile};

pub struct WorkOs {
    pub api_key: String,
    pub base_url: String,
    client: reqwest::Client,
}

impl WorkOs {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            base_url: "https://api.workos.com".to_string(),
            client: reqwest::Client::new(),
        }
    }

    pub async fn get_organization(&self, id: &str) -> Result<Organization, WorkOsError> {
        todo!()
    }

    pub async fn list_organizations(&self, opts: ListOrganizationsOpts) -> Result<Vec<Organization>, WorkOsError> {
        todo!()
    }

    pub async fn create_organization(&self, name: &str, domains: Option<Vec<String>>) -> Result<Organization, WorkOsError> {
        todo!()
    }

    pub async fn delete_organization(&self, id: &str) -> Result<(), WorkOsError> {
        todo!()
    }

    pub async fn get_connection(&self, id: &str) -> Result<Connection, WorkOsError> {
        todo!()
    }

    pub async fn get_profile(&self, token: &str) -> Result<Profile, WorkOsError> {
        todo!()
    }

    fn internal_request(&self, _path: &str) {
        // Private — should not appear in surface
    }
}

pub struct ListOrganizationsOpts {
    pub limit: Option<i64>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub domains: Option<Vec<String>>,
}

#[derive(Debug)]
pub struct WorkOsError {
    pub message: String,
    pub status_code: Option<u16>,
    pub request_id: Option<String>,
}

pub trait SsoProvider {
    async fn get_authorization_url(&self, opts: AuthUrlOpts) -> Result<String, WorkOsError>;
    async fn get_profile_and_token(&self, code: &str) -> Result<Profile, WorkOsError>;
}

pub struct AuthUrlOpts {
    pub redirect_uri: String,
    pub client_id: String,
    pub provider: Option<String>,
    pub connection: Option<String>,
    pub organization: Option<String>,
    pub state: Option<String>,
}
