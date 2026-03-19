defmodule WorkOS.Organizations do
  @moduledoc """
  Module for interacting with the Organizations API.
  """

  alias WorkOS.Organizations.Organization

  @doc """
  Gets an organization by ID.
  """
  @spec get_organization(client :: map(), id :: String.t()) :: {:ok, Organization.t()} | {:error, any()}
  def get_organization(client, id) do
    # implementation
  end

  @doc """
  Lists organizations.
  """
  @spec list_organizations(client :: map(), opts :: keyword()) :: {:ok, map()} | {:error, any()}
  def list_organizations(client, opts \\ []) do
    # implementation
  end

  @doc """
  Creates an organization.
  """
  @spec create_organization(client :: map(), params :: map()) :: {:ok, Organization.t()} | {:error, any()}
  def create_organization(client, params) do
    # implementation
  end

  @doc """
  Deletes an organization by ID.
  """
  @spec delete_organization(client :: map(), id :: String.t()) :: :ok | {:error, any()}
  def delete_organization(client, id) do
    # implementation
  end

  # Private function — should not appear
  defp internal_helper(client) do
    # implementation
  end
end
