#!/bin/sh
# Runs every automated test. Requires Go ≥ 1.24, Node ≥ 20 and Playwright's
# Chromium (headless tests render through SwiftShader when no GPU exists).
set -e
cd "$(dirname "$0")/.."
echo "── build wallpaper"; (cd web && npm ci --silent && npx tsc --noEmit -p . && npm run build --silent)
echo "── helper unit tests (go)"; (cd helper/service && GOTOOLCHAIN=local go vet ./... && GOTOOLCHAIN=local GOOS=windows go vet ./... && GOTOOLCHAIN=local go test -count=1 ./...)
echo "── helper black-box security + launch tests"; node --test tests/helper-security/*.test.mjs tests/launch/*.test.mjs
echo "── wallpaper behaviour tests"; node --test tests/integration/wallpaper.test.mjs
echo "── wallpaper ↔ helper end-to-end"; node --test tests/integration/wallpaper-helper.test.mjs
echo "── desktop probe plumbing"; node --test tests/integration/desktop-probe.test.mjs
echo "── phase 0 probe"; node tests/integration/phase0.probe.mjs > /dev/null && echo ok
echo "ALL TESTS PASSED"
