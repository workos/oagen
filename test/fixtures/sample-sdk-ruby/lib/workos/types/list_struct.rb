# frozen_string_literal: true

module WorkOS
  module Types
    class ListStruct
      attr_accessor :data, :list_metadata

      def initialize(data:, list_metadata:)
        @data = data
        @list_metadata = list_metadata
      end
    end
  end
end
