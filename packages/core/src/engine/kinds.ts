import type { FileKind } from './model.js';

/**
 * What kind of file a path is, decided by where it lives and what it is
 * called. The first answer to "does this PR need testing at all?": docs, CI,
 * build tooling and tests change nothing the running app does.
 */
export function fileKind(path: string): FileKind {
  const f = path;
  if (/(^|\/)src\/test\/|(^|\/)(test|tests|__tests__|e2e|cypress|playwright)\/|\.(spec|test|cy)\.\w+$/.test(f)) return 'test';
  if (/\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|svg|ico)$|(^|\/)(LICENSE|NOTICE|CHANGELOG|CODEOWNERS|AUTHORS)(\.\w+)?$|^docs?\//i.test(f) && !/src\/main\/(resources|webapp)\//.test(f)) return 'docs';
  if (/^\.github\/|^\.gitlab-ci|^\.circleci\/|^Jenkinsfile|^azure-pipelines|^\.travis/.test(f)) return 'ci';
  if (/^\.devcontainer\/|^\.vscode\/|^\.idea\/|^\.husky\/|(^|\/)\.(editorconfig|gitattributes|gitignore|prettierrc[^/]*|prettierignore|eslintrc[^/]*|lintstagedrc[^/]*|nvmrc|sdkmanrc)$|(^|\/)\.mvn\/|(^|\/)(mvnw|mvnw\.cmd|gradlew|gradlew\.bat|npmw|npmw\.cmd)$|(^|\/)gradle\/wrapper\/|(^|\/)(eslint|prettier|checkstyle|sonar-project|renovate|\.?release-please)[\w.-]*\.(js|cjs|mjs|ts|json|xml|properties)$|^build-plugins\//.test(f)) return 'tooling';
  if (/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|gradle\.properties|libs\.versions\.toml)$/.test(f)) return 'dependencies';
  if (/(^|\/)(docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|Dockerfile[^/]*|\.dockerignore)$|(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|docker)\/|(^|\/)prometheus[^/]*\.ya?ml$/.test(f)) return 'deploy';
  // scripts outside deployment folders start things on a developer's machine
  if (/\.(sh|ps1|cmd|bat)$/.test(f)) return 'tooling';
  if (/(^|\/)i18n\/|(^|\/)locales?\/|(^|\/)messages(_[\w-]+)?\.properties$/.test(f)) return 'i18n';
  if (/(^|\/)src\/main\/resources\/(config\/)?(application|bootstrap)[^/]*\.(ya?ml|properties)$|(^|\/)\.env(\.\w+)?$/.test(f)) return 'config';
  if (/\.(sql)$|(^|\/)(liquibase|flyway|migrations?|db)\//.test(f)) return 'data';
  if (/\.(java|kt|scala|groovy)$/.test(f)) return 'java';
  if (/\.(css|scss|sass|less|styl)$/.test(f)) return 'style';
  if (/\.(vue|jsx?|tsx?|mjs|cjs|html?|svelte)$/.test(f)) return 'frontend';
  return 'other';
}

/** For kinds that cannot change the running app: why. */
export function noAppEffect(kind: FileKind): string | null {
  switch (kind) {
    case 'docs': return 'documentation: the running app does not read it';
    case 'ci': return 'CI pipeline: it changes how the project is checked, not what the app does';
    case 'tooling': return 'build and editor tooling: a broken build shows in CI, the app does not change';
    default: return null;
  }
}
