# frozen_string_literal: true

module WorkOS
  class User
    include HashProvider

    attr_accessor :id, :email, :first_name, :last_name, :email_verified

    def initialize(json)
      hash = JSON.parse(json, symbolize_names: true)

      @id = hash[:id]
      @email = hash[:email]
      @first_name = hash[:first_name]
      @last_name = hash[:last_name]
      @email_verified = hash[:email_verified]
    end

    def to_json(*)
      {
        id: id,
        email: email,
        first_name: first_name,
        last_name: last_name,
        email_verified: email_verified,
      }
    end
  end
end
