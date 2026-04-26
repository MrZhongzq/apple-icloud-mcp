#!/bin/bash

# Navigate to the directory of this script, then up to the root project
cd "$(dirname "$0")/.."

echo "Starting Apple iCloud MCP..."

if ! command -v node &> /dev/null
then
    echo "Node.js could not be found. Please install Node.js from https://nodejs.org/"
    exit 1
fi

if ! command -v npm &> /dev/null
then
    echo "npm could not be found. Please install Node.js."
    exit 1
fi

echo "Installing dependencies..."
npm install

echo "Starting the server..."
npm start
