export interface LanguageCapabilities {
  supportsAstMerge: boolean;
  supportsExtractor: boolean;
  supportsSmokeRunner: boolean;
  supportsTargetIntegration: boolean;
}

const DEFAULT_CAPABILITIES: LanguageCapabilities = {
  supportsAstMerge: false,
  supportsExtractor: false,
  supportsSmokeRunner: false,
  supportsTargetIntegration: true,
};

const CAPABILITIES: Record<string, LanguageCapabilities> = {
  node: {
    supportsAstMerge: true,
    supportsExtractor: true,
    supportsSmokeRunner: true,
    supportsTargetIntegration: true,
  },
  php: {
    supportsAstMerge: true,
    supportsExtractor: true,
    supportsSmokeRunner: true,
    supportsTargetIntegration: true,
  },
  python: {
    supportsAstMerge: true,
    supportsExtractor: true,
    supportsSmokeRunner: true,
    supportsTargetIntegration: true,
  },
  ruby: {
    supportsAstMerge: true,
    supportsExtractor: true,
    supportsSmokeRunner: true,
    supportsTargetIntegration: true,
  },
  go: {
    supportsAstMerge: false,
    supportsExtractor: true,
    supportsSmokeRunner: true,
    supportsTargetIntegration: true,
  },
  rust: {
    supportsAstMerge: false,
    supportsExtractor: true,
    supportsSmokeRunner: true,
    supportsTargetIntegration: true,
  },
};

export function getLanguageCapabilities(language: string): LanguageCapabilities {
  return CAPABILITIES[language] ?? DEFAULT_CAPABILITIES;
}
