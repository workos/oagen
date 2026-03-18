package organizations

import (
	"context"

	"github.com/example/sample-sdk-go/pkg/common"
)

// Status represents the status of an organization.
type Status string

// Constants that enumerate the available statuses.
const (
	Active   Status = "active"
	Inactive Status = "inactive"
)

// Order represents the order of records.
type Order string

// Constants that enumerate the available orders.
const (
	Asc  Order = "asc"
	Desc Order = "desc"
)

// Client represents a client that performs Organization requests.
type Client struct {
	// The API Key.
	APIKey string

	// The endpoint URL.
	Endpoint string

	// unexported field - should not appear
	httpClient interface{}
}

// Organization contains data about an Organization.
type Organization struct {
	// The Organization's unique identifier.
	ID string `json:"id"`

	// The Organization's name.
	Name string `json:"name"`

	// The Organization's status.
	Status Status `json:"status"`

	// Whether profiles outside org are allowed.
	AllowProfilesOutsideOrganization bool `json:"allow_profiles_outside_organization"`

	// The Organization's domains.
	Domains []string `json:"domains"`

	// The Organization's metadata.
	Metadata map[string]string `json:"metadata"`

	// The timestamp of when the Organization was created.
	CreatedAt string `json:"created_at"`

	// The timestamp of when the Organization was updated.
	UpdatedAt string `json:"updated_at"`
}

// GetOrganizationOpts contains the options to request an Organization.
type GetOrganizationOpts struct {
	// Organization unique identifier.
	Organization string
}

// ListOrganizationsOpts contains the options to request Organizations.
type ListOrganizationsOpts struct {
	// Maximum number of records to return.
	Limit int `url:"limit,omitempty"`

	// The order in which to paginate records.
	Order Order `url:"order,omitempty"`

	// Pagination cursor.
	After string `url:"after,omitempty"`
}

// ListOrganizationsResponse describes the response structure.
type ListOrganizationsResponse struct {
	// List of Organizations.
	Data []Organization `json:"data"`

	// Cursor pagination options.
	ListMetadata common.ListMetadata `json:"list_metadata"`
}

// CreateOrganizationOpts contains the options to create an Organization.
type CreateOrganizationOpts struct {
	// Name of the Organization.
	Name string `json:"name"`

	// Domains of the Organization.
	Domains []string `json:"domains,omitempty"`
}

// DeleteOrganizationOpts contains the options to delete an Organization.
type DeleteOrganizationOpts struct {
	// Organization unique identifier.
	Organization string
}

// StatusAlias is a type alias for Status.
type StatusAlias = Status

// GetOrganization gets an Organization.
func (c *Client) GetOrganization(
	ctx context.Context,
	opts GetOrganizationOpts,
) (Organization, error) {
	return Organization{}, nil
}

// ListOrganizations gets a list of Organizations.
func (c *Client) ListOrganizations(
	ctx context.Context,
	opts ListOrganizationsOpts,
) (ListOrganizationsResponse, error) {
	return ListOrganizationsResponse{}, nil
}

// CreateOrganization creates an Organization.
func (c *Client) CreateOrganization(
	ctx context.Context,
	opts CreateOrganizationOpts,
) (Organization, error) {
	return Organization{}, nil
}

// DeleteOrganization deletes an Organization.
func (c *Client) DeleteOrganization(
	ctx context.Context,
	opts DeleteOrganizationOpts,
) error {
	return nil
}

// unexportedHelper is not exported and should not appear.
func (c *Client) unexportedHelper() {}

// SetAPIKey sets the API key on the default client.
func SetAPIKey(apiKey string) {
	// package-level function
}
