import type { EmitterContext, GeneratedFile } from "../../engine/types.js";

export function generateConfig(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;

  const content = `module ${ns}
  class Configuration
    attr_accessor :api_key, :base_url, :max_retries, :timeout

    def initialize
      @api_key = ENV["${ctx.namespace.toUpperCase()}_API_KEY"]
      @base_url = "https://api.${ctx.namespace.replace(/_/g, "")}.com"
      @max_retries = 2
      @timeout = 60
    end
  end

  class << self
    def configure
      yield(configuration)
    end

    def configuration
      @configuration ||= Configuration.new
    end
  end
end
`;

  return [
    {
      path: `lib/${ctx.namespace}/configuration.rb`,
      content,
    },
  ];
}
