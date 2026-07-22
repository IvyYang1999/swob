/**
 * Keep Electron E2E locale deterministic without allowing production callers
 * to override the user's operating-system language.
 */
export function preferredSystemLanguagesForRuntime(
  systemLanguages: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const testLocale = environment.SWOB_TEST_LOCALE
  if (environment.NODE_ENV === 'test' && environment.SWOB_TEST_HOME && testLocale) {
    return [testLocale]
  }
  return systemLanguages
}
