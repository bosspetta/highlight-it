// web-ext-config.mjs — options picked up automatically by `web-ext`.
// web-ext packages the folder, not the git tree, so files kept out of the
// repo with .gitignore must be excluded here too.
export default {
  ignoreFiles: [
    "notes.txt",
    "web-ext-config.mjs",
  ],
  build: {
    overwriteDest: true,
  },
};
