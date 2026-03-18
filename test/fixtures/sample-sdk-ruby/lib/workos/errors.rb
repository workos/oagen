# frozen_string_literal: true

module WorkOS
  class WorkOSError < StandardError
    attr_reader :http_status
    attr_reader :request_id

    def initialize(message: nil, http_status: nil, request_id: nil)
      @message = message
      @http_status = http_status
      @request_id = request_id
    end
  end

  class APIError < WorkOSError; end

  class AuthenticationError < WorkOSError; end
end
