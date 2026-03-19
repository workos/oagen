defmodule WorkOS.SSO.ConnectionType do
  @moduledoc """
  Enum for connection types.
  """

  @type t :: :generic_oidc | :generic_saml

  def generic_oidc, do: "GenericOIDC"
  def generic_saml, do: "GenericSAML"

  def values, do: ["GenericOIDC", "GenericSAML"]
end

defmodule WorkOS.SSO.Connection do
  @moduledoc """
  Struct representing an SSO Connection.
  """

  @type t :: %__MODULE__{
    id: String.t(),
    organization_id: String.t(),
    connection_type: String.t(),
    name: String.t(),
    state: String.t()
  }

  defstruct [:id, :organization_id, :connection_type, :name, :state]
end

defmodule WorkOS.SSO.Profile do
  @moduledoc """
  Struct representing an SSO Profile.
  """

  @type t :: %__MODULE__{
    id: String.t(),
    email: String.t(),
    first_name: String.t() | nil,
    last_name: String.t() | nil,
    connection_id: String.t(),
    organization_id: String.t()
  }

  defstruct [:id, :email, :first_name, :last_name, :connection_id, :organization_id]
end

defmodule WorkOS.SSO do
  @moduledoc """
  Module for interacting with the SSO API.
  """

  alias WorkOS.SSO.{Connection, Profile}

  @doc """
  Gets a connection by ID.
  """
  @spec get_connection(client :: map(), id :: String.t()) :: {:ok, Connection.t()} | {:error, any()}
  def get_connection(client, id) do
    # implementation
  end

  @doc """
  Gets a profile by token.
  """
  @spec get_profile(client :: map(), token :: String.t()) :: {:ok, Profile.t()} | {:error, any()}
  def get_profile(client, token) do
    # implementation
  end
end
