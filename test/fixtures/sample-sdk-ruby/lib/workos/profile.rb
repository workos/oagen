# frozen_string_literal: true

module WorkOS
  class Profile
    include HashProvider

    attr_accessor :id, :email, :first_name, :last_name,
                  :connection_id, :connection_type, :organization_id

    def initialize(profile_json)
      hash = JSON.parse(profile_json, symbolize_names: true)

      @id = hash[:id]
      @email = hash[:email]
      @first_name = hash[:first_name]
      @last_name = hash[:last_name]
      @connection_id = hash[:connection_id]
      @connection_type = hash[:connection_type]
      @organization_id = hash[:organization_id]
    end

    def full_name
      [first_name, last_name].compact.join(' ')
    end

    def to_json(*)
      {
        id: id,
        email: email,
        first_name: first_name,
        last_name: last_name,
        connection_id: connection_id,
        connection_type: connection_type,
        organization_id: organization_id,
      }
    end
  end
end
