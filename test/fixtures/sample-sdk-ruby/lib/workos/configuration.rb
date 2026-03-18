# frozen_string_literal: true

module WorkOS
  class Configuration
    attr_accessor :api_hostname, :timeout, :key

    def initialize
      @timeout = 60
    end

    def key!
      key or raise '`WorkOS.config.key` not set'
    end
  end
end
