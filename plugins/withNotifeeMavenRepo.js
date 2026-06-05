/**
 * Expo config plugin: register notifee's bundled Maven repo at the ROOT project.
 *
 * `@notifee/react-native` ships its native Android artifact (`app.notifee:core`)
 * as a local Maven repo inside the npm package
 * (node_modules/@notifee/react-native/android/libs) and adds that repo from
 * within its OWN subproject's build.gradle. That works for a normal build, but
 * `expo run:android` passes `--configure-on-demand`, under which the notifee
 * subproject isn't configured before `:app` resolves its dependencies — so
 * `app.notifee:core:+` can't be found and the build fails:
 *
 *   > Could not find any matches for app.notifee:core:+ ...
 *     Required by: project :app > project :notifee_react-native
 *
 * Declaring the same local Maven repo in the root `allprojects.repositories`
 * makes it available regardless of configuration order. Uses the portable
 * `$rootDir/../node_modules/...` gradle expression (rootDir = android/), so it
 * works on any machine and survives `expo prebuild` (android/ is git-ignored).
 */
const { withProjectBuildGradle } = require('@expo/config-plugins');

const MARKER = '@notifee/react-native/android/libs';
const REPO_LINE =
  '    maven { url "$rootDir/../node_modules/@notifee/react-native/android/libs" } // notifee:core — configure-on-demand safe';

const withNotifeeMavenRepo = (config) =>
  withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg;
    let { contents } = cfg.modResults;
    if (contents.includes(MARKER)) return cfg; // already added

    const replaced = contents.replace(
      /allprojects\s*\{\s*repositories\s*\{/,
      (match) => `${match}\n${REPO_LINE}`,
    );
    if (replaced === contents) {
      throw new Error(
        '[withNotifeeMavenRepo] could not find an allprojects { repositories { block in android/build.gradle',
      );
    }
    cfg.modResults.contents = replaced;
    return cfg;
  });

module.exports = withNotifeeMavenRepo;
