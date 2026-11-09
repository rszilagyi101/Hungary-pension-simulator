// Load the browser engine scripts into Node's global scope.
const fs = require("fs"), path = require("path"), vm = require("vm");
module.exports = function load(files) {
  let dir = path.join(__dirname, "..", "assets", "js");
  if (!fs.existsSync(dir)) dir = path.join(__dirname, "..", "..", "site", "assets", "js");  // packaged layout
  for (const f of files || ["ps-defaults.js", "ps-core.js", "ps-data.js", "ps-population.js", "ps-models.js", "ps-scenarios.js"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
  }
  return globalThis.PS;
};
