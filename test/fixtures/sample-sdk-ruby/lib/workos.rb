# frozen_string_literal: true

require 'workos/version'
require 'json'
require 'workos/hash_provider'
require 'workos/configuration'

module WorkOS
  def self.config
    @config ||= Configuration.new
  end

  def self.configure
    yield(config)
  end

  autoload :Client, 'workos/client'
  autoload :Configuration, 'workos/configuration'
  autoload :Connection, 'workos/connection'
  autoload :Organization, 'workos/organization'
  autoload :Organizations, 'workos/organizations'
  autoload :Profile, 'workos/profile'
  autoload :SSO, 'workos/sso'
  autoload :Types, 'workos/types'
  autoload :User, 'workos/user'

  # Errors
  autoload :APIError, 'workos/errors'
  autoload :AuthenticationError, 'workos/errors'
end
