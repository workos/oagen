# frozen_string_literal: true

require 'net/http'

module WorkOS
  module Organizations
    class << self
      include Client

      def list_organizations(options = {})
        # list implementation
      end

      def get_organization(id:)
        # get implementation
      end

      def create_organization(name:, domain_data: nil, idempotency_key: nil)
        # create implementation
      end

      def delete_organization(id:)
        # delete implementation
      end

      private

      def check_and_raise_organization_error(response:)
        # error handling
      end
    end
  end
end
