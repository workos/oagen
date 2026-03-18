# frozen_string_literal: true

module WorkOS
  class Connection
    include HashProvider

    attr_accessor :id, :name, :connection_type, :state
    attr_reader :organization_id

    def initialize(json)
      hash = JSON.parse(json, symbolize_names: true)

      @id = hash[:id]
      @name = hash[:name]
      @connection_type = hash[:connection_type]
      @organization_id = hash[:organization_id]
      @state = hash[:state]
    end

    def to_json(*)
      {
        id: id,
        name: name,
        connection_type: connection_type,
        organization_id: organization_id,
        state: state,
      }
    end
  end
end
