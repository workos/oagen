# frozen_string_literal: true

module WorkOS
  class Organization
    include HashProvider

    attr_accessor :id, :name, :created_at, :updated_at
    attr_reader :domains

    def initialize(json)
      hash = JSON.parse(json, symbolize_names: true)

      @id = hash[:id]
      @name = hash[:name]
      @domains = hash[:domains]
      @created_at = hash[:created_at]
      @updated_at = hash[:updated_at]
    end

    def to_json(*)
      {
        id: id,
        name: name,
        domains: domains,
        created_at: created_at,
        updated_at: updated_at,
      }
    end
  end
end
