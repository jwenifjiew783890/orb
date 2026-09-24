// Shared headless Chromium launcher for integration tests and screenshots.
// NOTE: the container has no GPU; Chromium renders WebGL2 through SwiftShader
// (CPU rasteriser). Visual output is faithful; performance numbers are NOT
// representative of a real GPU and are labelled as such wherever recorded.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export async function launch() {
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
  return chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--allow-file-access-from-files=false"],
  });
}
