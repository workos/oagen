defmodule WorkOS.Organizations.Organization do
  @moduledoc """
  Struct representing an Organization.
  """

  @type t :: %__MODULE__{
    id: String.t(),
    name: String.t(),
    status: String.t(),
    allow_profiles_outside_organization: boolean(),
    domains: [String.t()] | nil,
    created_at: String.t(),
    updated_at: String.t()
  }

  defstruct [:id, :name, :status, :allow_profiles_outside_organization, :domains, :created_at, :updated_at]
end

defmodule WorkOS.Organizations.Status do
  @moduledoc """
  Enum for organization status.
  """

  @type t :: :active | :inactive

  def active, do: "active"
  def inactive, do: "inactive"

  def values, do: ["active", "inactive"]
end

defmodule WorkOS.Organizations.Order do
  @moduledoc """
  Enum for ordering.
  """

  @type t :: :asc | :desc

  def asc, do: "asc"
  def desc, do: "desc"

  def values, do: ["asc", "desc"]
end

defmodule WorkOS.Organizations.ListOrganizationsResponse do
  @moduledoc """
  Struct representing a list organizations response.
  """

  @type t :: %__MODULE__{
    data: [WorkOS.Organizations.Organization.t()],
    list_metadata: WorkOS.Common.ListMetadata.t()
  }

  defstruct [:data, :list_metadata]
end

defmodule WorkOS.Organizations.CreateOrganizationOptions do
  @moduledoc """
  Options for creating an organization.
  """

  @type t :: %__MODULE__{
    name: String.t(),
    domains: [String.t()] | nil
  }

  defstruct [:name, :domains]
end
