# frozen_string_literal: true

module WorkOS
  module Types
    module Provider
      Apple = 'AppleOAuth'
      GitHub = 'GitHubOAuth'
      Google = 'GoogleOAuth'
      Microsoft = 'MicrosoftOAuth'

      ALL = [Apple, GitHub, Google, Microsoft].freeze
    end
  end
end
