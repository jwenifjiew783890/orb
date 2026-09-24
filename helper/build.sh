#!/bin/sh
# Reproducible build of the Windows helper (run from any OS with Go ≥ 1.24).
set -e
cd "$(dirname "$0")/service"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 GOTOOLCHAIN=local \
  go build -trimpath -ldflags "-s -w -H windowsgui -buildid=" -o ../bin/vision-helper.exe .
sha256sum ../bin/vision-helper.exe 2>/dev/null || shasum -a 256 ../bin/vision-helper.exe
