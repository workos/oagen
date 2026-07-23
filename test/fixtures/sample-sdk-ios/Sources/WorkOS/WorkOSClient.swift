// @oagen-ignore-file

import Foundation

/// The WorkOS API client. Hand-maintained; excluded from extraction.
public final class WorkOSClient: Sendable {
    /// The configuration this client was created with.
    public let configuration: Configuration
    let transport: Transport

    init(configuration: Configuration, transport: Transport) {
        self.configuration = configuration
        self.transport = transport
    }

    /// Create a client with an API key and an optional base URL override.
    public convenience init(apiKey: String, baseURL: URL? = nil) {
        self.init(
            configuration: Configuration(apiKey: apiKey, baseURL: baseURL ?? URL(string: "https://api.workos.com")!),
            transport: Transport()
        )
    }

    public func handWrittenHelper() -> String {
        return "not extracted"
    }
}
