#!/bin/bash
# Build script — packages DomainGuard for Firefox Add-ons (AMO) submission.
# Produces domainguard-<version>.zip in the current directory.

set -e

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
OUTPUT="domainguard-${VERSION}.zip"

# Remove old build if present
rm -f "$OUTPUT"

zip -r "$OUTPUT" \
  manifest.json \
  LICENSE \
  PRIVACY.md \
  background/ \
  content/ \
  panel/ \
  popup/ \
  sidebar/ \
  utils/ \
  icons/ \
  -x "*.DS_Store"

echo "Built ${OUTPUT} ($(du -h "$OUTPUT" | cut -f1))"
