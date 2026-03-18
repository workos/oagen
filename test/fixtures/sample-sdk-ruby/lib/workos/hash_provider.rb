# frozen_string_literal: true

module WorkOS
  module HashProvider
    include Kernel

    def to_json(*)
      raise 'Must be implemented by including class.'
    end

    def to_h
      to_json
    end
  end
end
