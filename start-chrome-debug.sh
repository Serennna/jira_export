#!/bin/bash
# Start Chrome with remote debugging so Playwright can connect to it.
# Run this once, log in to Jira normally, then run the export script.

echo "Quitting any existing Chrome..."
pkill -x "Google Chrome" 2>/dev/null
sleep 2

echo "Starting Chrome with remote debugging on port 9222..."
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile \
  &

echo ""
echo "Chrome is now open with remote debugging."
echo "1. Log in to Jira normally in that Chrome window."
echo "2. Once logged in, run:"
echo "   node export-steps-ui.js ACIOSMAU-88"
echo ""
