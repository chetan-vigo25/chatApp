// module.exports = function(api) {
//     api.cache(true);
//     return {
//       presets: ['babel-preset-expo'],
//       plugins: [
//         [
//           "module:react-native-dotenv",
//           {
//             moduleName: "@env",
//             path: ".env",
//             allowUndefined: true,
//           }
//         ],
//         // Reanimated/Worklets plugin MUST be listed last.
//         "react-native-worklets/plugin",
//       ]
//     };
//   };
  



module.exports = function(api) {
    api.cache(true);
    // Production/release bundles strip ALL console.* calls (except error/warn):
    // the app logs heavily on the hot message/media paths (full payload dumps),
    // and every call serializes its arguments — a measurable JS-thread cost
    // that contributes to release-build jank. Dev keeps every log.
    const isProduction = process.env.NODE_ENV === 'production' || process.env.BABEL_ENV === 'production';
    return {
      presets: ['babel-preset-expo'],
      plugins: [
        [
          "module:react-native-dotenv",
          {
            moduleName: "@env",
            path: ".env",
            allowUndefined: true,
          }
        ],
        ...(isProduction ? [["transform-remove-console", { exclude: ["error", "warn"] }]] : []),
        // Reanimated/Worklets plugin MUST be listed last.
        "react-native-worklets/plugin",
      ]
    };
  };