const stripUnusedTailwindImport = {
  postcssPlugin: "strip-unused-tailwind-import",
  AtRule: {
    import(atRule) {
      if (atRule.params === '"tailwindcss"' || atRule.params === "'tailwindcss'") {
        atRule.remove();
      }
    },
  },
};

const config = {
  plugins: [stripUnusedTailwindImport],
};

export default config;
