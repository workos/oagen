defmodule WorkOS.Common.ListMetadata do
  @moduledoc """
  Struct representing list pagination metadata.
  """

  @type t :: %__MODULE__{
    before: String.t() | nil,
    after: String.t() | nil
  }

  defstruct [:before, :after]
end
