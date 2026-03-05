import type { EmitterContext, GeneratedFile } from "../../engine/types.js";

export function generateErrors(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;

  const content = `module ${ns}
  class APIError < StandardError
    attr_reader :status, :message, :request_id, :code

    def initialize(status:, message:, request_id: nil, code: nil)
      @status = status
      @message = message
      @request_id = request_id
      @code = code
      super(message)
    end
  end

  class AuthenticationError < APIError; end
  class NotFoundError < APIError; end
  class UnprocessableEntityError < APIError; end
  class RateLimitExceededError < APIError; end
  class ServerError < APIError; end
  class NetworkError < APIError; end
  class ConfigurationError < StandardError; end
end
`;

  return [
    {
      path: `lib/${ctx.namespace}/errors.rb`,
      content,
    },
  ];
}
