#!/usr/bin/env bash
# KennisBoost Tools - One-Click Application Launcher
PORT=8000
echo "=========================================================="
echo "  🚀 Starting KennisBoost Tools..."
echo "  100% Client-Side Educational Suite (Zero Cloud Dependency)"
echo "=========================================================="

# Check if node is installed
if ! command -v node > /dev/null 2>&1; then
  echo "Error: Node.js is required to serve the local files. Please install Node.js."
  exit 1
fi

echo "Serving local files at http://localhost:$PORT ..."
node server.js &
SERVER_PID=$!

# Give server a moment to start
sleep 1

# Open default browser
if command -v xdg-open > /dev/null 2>&1; then
  xdg-open "http://localhost:$PORT" > /dev/null 2>&1 &
elif command -v open > /dev/null 2>&1; then
  open "http://localhost:$PORT" > /dev/null 2>&1 &
fi

echo ""
echo "👉 App open in your browser at: http://localhost:$PORT"
echo "Press Ctrl+C to stop the local server."
echo ""

wait $SERVER_PID
