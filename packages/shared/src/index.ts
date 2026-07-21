// @chromatrix/shared - code shared between chromatrix packages and apps. Lean by policy: zod is the only
// runtime dependency, because the published CLI depends on this and every dependency here is one a user
// installs with `npx chromatrix`.
//
// Today that is config resolution + the access token. Anything added later must clear the same bar: needed by
// at least two of {gateway, cli, web, core}, and cheap to install.

export { configDir, configPath, dataDir } from './paths.ts'
export {
  ConfigError,
  ConfigSchema,
  DEFAULT_HOST,
  DEFAULT_PORT,
  configJsonSchema,
  isConfigFileExposed,
  loadConfig,
  readConfigFile,
  writeConfigFile,
  type Config,
  type StoredConfig,
} from './config.ts'
export {
  deriveAgentToken,
  ensureToken,
  generateToken,
  tokensMatch,
  type EnsuredToken,
} from './token.ts'
