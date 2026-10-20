/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  roots: ['<rootDir>/src'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  testEnvironment: "node",
  transform: {
    "^.+\\.[tj]sx?$": ["ts-jest", {
      tsconfig: {
        module: "CommonJS",
        moduleResolution: "node",
        allowJs: true,
        isolatedModules: true,
      },
    }],
  },
  // Dinero 2 ships ESM; transform it for the existing CommonJS Jest runtime.
  transformIgnorePatterns: ["/node_modules/(?!dinero\\.js/)"],
};
