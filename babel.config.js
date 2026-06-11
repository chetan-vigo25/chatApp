module.exports = function(api) {
    api.cache(true);
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
        // Reanimated/Worklets plugin MUST be listed last.
        "react-native-worklets/plugin",
      ]
    };
  };
  