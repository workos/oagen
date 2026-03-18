# frozen_string_literal: true

module WorkOS
  module Client
    include Kernel

    def client
      # HTTP client factory
    end

    def execute_request(request:)
      # Execute HTTP request
    end

    def get_request(path:, auth: false, params: {}, access_token: nil)
      # Build GET request
    end

    def post_request(path:, auth: false, idempotency_key: nil, body: nil)
      # Build POST request
    end

    def delete_request(path:, auth: false, params: {})
      # Build DELETE request
    end

    def put_request(path:, auth: false, idempotency_key: nil, body: nil)
      # Build PUT request
    end

    private

    def handle_error_response(response:)
      # Handle errors
    end
  end
end
