/**
 * Structured error hierarchy for oagen.
 *
 * Every error carries a human-readable `hint` that suggests a recovery action.
 * The hint is appended to the `message` so it appears in stack traces and logs.
 */

/** Base class for all oagen errors. */
export class OagenError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    const fullMessage = hint ? `${message}\nHint: ${hint}` : message;
    super(fullMessage);
    this.name = 'OagenError';
    this.hint = hint;
  }
}

/** Thrown when a command should terminate with a specific exit code. */
export class CommandError extends OagenError {
  readonly exitCode: number;

  constructor(message: string, hint: string, exitCode: number) {
    super(message, hint);
    this.name = 'CommandError';
    this.exitCode = exitCode;
  }
}

/** Thrown when an OpenAPI spec cannot be parsed or has an unsupported version. */
export class SpecParseError extends OagenError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'SpecParseError';
  }
}

/** Thrown when configuration files (manifests, API surfaces, overlays) are missing or malformed. */
export class ConfigError extends OagenError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'ConfigError';
  }
}

/** Thrown when a config file exists but cannot be loaded or evaluated. */
export class ConfigLoadError extends ConfigError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'ConfigLoadError';
  }
}

/** Thrown when a config targets a different IR version than the installed package. */
export class ConfigVersionMismatchError extends ConfigError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'ConfigVersionMismatchError';
  }
}

/** Thrown when an API surface extractor encounters a problem. */
export class ExtractorError extends OagenError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'ExtractorError';
  }
}

/** Thrown when a requested language or extractor is not found in a registry. */
export class RegistryError extends OagenError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'RegistryError';
  }
}

/** Thrown for internal invariant violations that indicate a bug. */
export class InternalError extends OagenError {
  constructor(message: string, hint: string) {
    super(message, hint);
    this.name = 'InternalError';
  }
}
