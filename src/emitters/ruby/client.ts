import type { ApiSpec } from "../../ir/types.js";
import type { EmitterContext, GeneratedFile } from "../../engine/types.js";
import { toSnakeCase } from "../../utils/naming.js";
import { rubyClassName } from "./naming.js";

export function generateClient(
  _spec: ApiSpec,
  ctx: EmitterContext,
): GeneratedFile[] {
  const ns = ctx.namespacePascal;

  const resourceAccessors = ctx.spec.services
    .map((s) => {
      const methodName = toSnakeCase(s.name);
      const className = rubyClassName(s.name);
      return [
        `    # @return [${ns}::Resources::${className}]`,
        `    def ${methodName}`,
        `      @${methodName} ||= ${ns}::Resources::${className}.new(client: self)`,
        "    end",
      ].join("\n");
    })
    .join("\n\n");

  const content = `require "net/http"
require "json"
require "securerandom"

module ${ns}
  class Client
    RETRYABLE_STATUSES = [429, 500, 502, 503, 504].freeze
    MAX_RETRY_DELAY = 30

    # @return [String]
    attr_reader :api_key

    # @return [String]
    attr_reader :base_url

    # @return [Integer]
    attr_reader :max_retries

    # @param api_key [String, nil]
    # @param base_url [String, nil]
    # @param max_retries [Integer, nil]
    def initialize(api_key: nil, base_url: nil, max_retries: nil)
      @api_key = api_key || ${ns}.configuration.api_key
      @base_url = base_url || ${ns}.configuration.base_url
      @max_retries = max_retries || ${ns}.configuration.max_retries

      raise ${ns}::ConfigurationError, "API key is required" unless @api_key
    end

${resourceAccessors}

    # @api private
    def request(method:, path:, query: nil, body: nil, model: nil, page: nil, idempotency_key: nil, options: nil)
      resolved_path = if path.is_a?(Array)
        template, *args = path
        format(template, *args)
      else
        path
      end

      uri = URI.join(@base_url, resolved_path)
      uri.query = URI.encode_www_form(query) if query&.any?

      idempotency_key ||= SecureRandom.uuid if method == :post

      attempt = 0
      begin
        req = build_request(method, uri, body: body, idempotency_key: idempotency_key, options: options)
        response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|
          http.read_timeout = options&.dig(:timeout) || ${ns}.configuration.timeout
          http.request(req)
        end

        handle_response(response, model: model, page: page)
      rescue ${ns}::APIError => e
        if RETRYABLE_STATUSES.include?(e.status) && attempt < @max_retries
          attempt += 1
          delay = retry_delay(attempt, response)
          sleep(delay)
          retry
        end
        raise
      rescue Errno::ECONNREFUSED, Errno::ETIMEDOUT, Net::OpenTimeout, Net::ReadTimeout => e
        if attempt < @max_retries
          attempt += 1
          delay = retry_delay(attempt, nil)
          sleep(delay)
          retry
        end
        raise ${ns}::NetworkError.new(status: 0, message: e.message)
      end
    end

    private

    def build_request(method, uri, body:, idempotency_key:, options:)
      klass = {
        get: Net::HTTP::Get,
        post: Net::HTTP::Post,
        put: Net::HTTP::Put,
        patch: Net::HTTP::Patch,
        delete: Net::HTTP::Delete
      }.fetch(method)

      req = klass.new(uri)
      req["Authorization"] = "Bearer \#{@api_key}"
      req["Content-Type"] = "application/json"
      req["Idempotency-Key"] = idempotency_key if idempotency_key

      extra_headers = options&.dig(:extra_headers)
      extra_headers&.each { |k, v| req[k] = v }

      req.body = JSON.generate(body) if body
      req
    end

    def handle_response(response, model:, page:)
      status = response.code.to_i
      body = response.body
      request_id = response["x-request-id"]

      if status >= 400
        parsed = begin; JSON.parse(body); rescue; {}; end
        error_class = error_class_for_status(status)
        raise error_class.new(
          status: status,
          message: parsed["message"] || "Request failed with status \#{status}",
          request_id: request_id,
          code: parsed["code"]
        )
      end

      return nil if model == NilClass
      return nil if body.nil? || body.empty?

      parsed = JSON.parse(body)

      if page
        page.new(model: model, page: parsed)
      elsif model
        model.new(parsed)
      else
        parsed
      end
    end

    def error_class_for_status(status)
      case status
      when 401 then ${ns}::AuthenticationError
      when 404 then ${ns}::NotFoundError
      when 422 then ${ns}::UnprocessableEntityError
      when 429 then ${ns}::RateLimitExceededError
      when 500..599 then ${ns}::ServerError
      else ${ns}::APIError
      end
    end

    def retry_delay(attempt, response)
      if response&.is_a?(Net::HTTPResponse) && response["Retry-After"]
        return [response["Retry-After"].to_f, MAX_RETRY_DELAY].min
      end

      jitter = rand * 0.5
      [(2**attempt * 0.5) + jitter, MAX_RETRY_DELAY].min
    end
  end
end
`;

  return [
    {
      path: `lib/${ctx.namespace}/client.rb`,
      content,
    },
  ];
}
