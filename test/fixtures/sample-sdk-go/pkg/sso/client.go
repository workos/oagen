package sso

import (
	"context"
)

// ConnectionType represents a connection type.
type ConnectionType string

// Constants that enumerate the available connection types.
const (
	GenericOIDC ConnectionType = "GenericOIDC"
	GenericSAML ConnectionType = "GenericSAML"
)

// Client represents a client that fetch SSO data.
type Client struct {
	// The API Key.
	APIKey string

	// The Client ID.
	ClientID string
}

// Connection represents a Connection record.
type Connection struct {
	// Connection unique identifier.
	ID string `json:"id"`

	// Connection name.
	Name string `json:"name"`

	// Connection provider type.
	ConnectionType ConnectionType `json:"connection_type"`
}

// GetConnectionOpts contains the options to get a Connection.
type GetConnectionOpts struct {
	// Connection unique identifier.
	Connection string
}

// GetConnection gets a Connection.
func (c *Client) GetConnection(
	ctx context.Context,
	opts GetConnectionOpts,
) (Connection, error) {
	return Connection{}, nil
}
