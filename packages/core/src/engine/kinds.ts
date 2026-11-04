import type { FileKind } from './model.js';

/**
 * What kind of file a path is, decided by where it lives and what it is
 * called. The first answer to "does this PR need testing at all?": docs, CI,
 * build tooling and tests change nothing the running app does.
 */
export function fileKind(path: string): FileKind {
  const f = path;
  if (/(^|\/)src\/test\/|(^|\/)(test|tests|__tests__|e2e|cypress|playwright)\/|\.(spec|test|cy)\.\w+$/.test(f)) return 'test';
  // a file the app serves or reads is not documentation, whatever its extension: public/, assets/, static/, templates/
  const served = /(^|\/)(public|static|assets?|www|wwwroot|webapp|resources|templates|content|images?|img|icons?|fonts?|media)\//i.test(f) && !/^docs?\//i.test(f);
  if (/(^|\/)(LICENSE|NOTICE|CHANGELOG|CODEOWNERS|AUTHORS|CONTRIBUTING|SECURITY|README)(\.\w+)?$/i.test(f) && !served) return 'docs';
  if (/^docs?\//i.test(f) || /^\.github\/.*\.(md|png|jpe?g|gif|svg)$/i.test(f)) return 'docs';
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(f) && !served) return 'docs';
  // an image beside the code is shown by the app somewhere; only images in docs, or at the root for the README, are documentation
  if (/\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot)$/i.test(f)) return !f.includes('/') ? 'docs' : 'asset';
  if (/^\.github\/|^\.gitlab-ci|^\.circleci\/|^Jenkinsfile|^azure-pipelines|^\.travis/.test(f)) return 'ci';
  if (/^\.devcontainer\/|^\.vscode\/|^\.idea\/|^\.husky\/|(^|\/)\.(editorconfig|gitattributes|gitignore|prettierrc[^/]*|prettierignore|eslintrc[^/]*|lintstagedrc[^/]*|nvmrc|sdkmanrc)$|(^|\/)\.mvn\/|(^|\/)(mvnw|mvnw\.cmd|gradlew|gradlew\.bat|npmw|npmw\.cmd)$|(^|\/)gradle\/wrapper\/|(^|\/)(eslint|prettier|checkstyle|sonar-project|renovate|\.?release-please)[\w.-]*\.(js|cjs|mjs|ts|json|xml|properties)$|^build-plugins\//.test(f)) return 'tooling';
  if (/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|gradle\.properties|libs\.versions\.toml)$/.test(f)) return 'dependencies';
  if (/(^|\/)(docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|Dockerfile[^/]*|\.dockerignore)$|(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|docker)\/|(^|\/)prometheus[^/]*\.ya?ml$/.test(f)) return 'deploy';
  // a script's name says where it runs: one that starts, deploys or migrates is part of how the app runs;
  // one that lints, formats or sets up a machine is tooling; any other is not known, so it is not followed
  if (/\.(sh|ps1|cmd|bat|bash|zsh)$/.test(f)) {
    const name = f.split('/').pop()!.toLowerCase();
    // loose on the side of caution: any hint of starting or deploying makes it deployment
    if (/entry|start|run|boot|launch|serve|deploy|release|migrat|cron|backup|restore|init|prod|healthcheck|docker/.test(name)) return 'deploy';
    // strict on the side of silence: tooling only when a whole word of the name says so ("reconcile" is not "ci")
    const words = name.replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((w) => /^(lint|eslint|format|fmt|test|tests|check|setup|install|bootstrap|codegen|generate|clean|dev|hooks?|precommit|commit|ci|build|bump|version)$/.test(w))) return 'tooling';
    return 'other';
  }
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
