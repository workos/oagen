# frozen_string_literal: true

require 'net/http'
require 'uri'

module WorkOS
  module SSO
    class << self
      include Client

      PROVIDERS = WorkOS::Types::Provider::ALL

      def authorization_url(redirect_uri:, client_id: nil, provider: nil, connection: nil, organization: nil, state: '')
        # build authorization URL
      end

      def get_profile(access_token:)
        # get profile
      end

      def list_connections(options = {})
        # list connections
      end

      def get_connection(id:)
        # get connection
      end

      def delete_connection(id:)
        # delete connection
      end

      private

      def validate_authorization_url_arguments(provider:, connection:, organization:)
        # validation
      end
    end
  end
end
