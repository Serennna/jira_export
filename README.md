# jira-xray-exporter

A Node.js CLI tool to export Jira test cases with Xray test steps to structured CSV and Excel files. It uses Playwright to intercept Xray API calls in the browser, avoiding the need for official Xray API credentials.

## Features

- Export Jira ticket metadata via the REST API
- Capture Xray test steps via Playwright browser network interception
- Export Test Sets with their contained Tests and step details
- Merge CSV outputs into styled, hierarchical Excel (`.xlsx`) files
- Supports headless operation after a one-time browser login

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm

## Installation

```bash
npm install
```

Install Playwright browsers (required for step capture):

```bash
npx playwright install chromium
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```dotenv
# Jira Cloud credentials
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your_jira_api_token

# Default ticket to export (can also be passed as a CLI argument)
JIRA_ISSUE_KEY=PROJECT-123

# Output directory
OUTPUT_DIR=./output
```

> **Never commit `.env` or `.auth/session.json` — they contain real credentials.**

You can generate a Jira API token at: https://id.atlassian.com/manage-profile/security/api-tokens

## Authentication

Before running any export that captures Xray steps, you must log in once to save a browser session:

```bash
npm run login
```

This opens a browser window for you to complete SSO. The session is saved to `.auth/session.json` for subsequent headless runs.

Alternatively, use your existing Chrome profile to skip manual SSO:

```bash
node setup-auth.js
```

## Usage

### Export Test Sets (recommended)

Exports all Xray Test Sets from a project, including their Tests and step details. Produces a mapping CSV, a steps CSV, and a merged Excel file.

```bash
# Default project (from .env / JIRA_BASE_URL)
npm run export:test-sets

# Specify a project
node export-test-sets.js --project ACANDMAU

# Filter Test Sets by summary tag (substring match, case-insensitive)
node export-test-sets.js --filter "[NS]"
node export-test-sets.js --filter "[NS],[NR]"

# Custom output directory
node export-test-sets.js --output ./output/ios

# Custom JQL
node export-test-sets.js --jql "project = ACIOSMAU AND issuetype = 'Test Set'"

# Skip step capture (mapping only)
node export-test-sets.js --no-steps
```

**Output files:**

| File | Description |
|---|---|
| `<outputDir>/<PROJECT>_TestSets_mapping.csv` | Test Set → Test mapping |
| `<outputDir>/<PROJECT>_TestSets_steps.csv` | One row per test step |
| `<outputDir>/<PROJECT>_TestSets_merged.xlsx` | Hierarchical styled Excel |

### Full Export (single ticket or bulk)

Exports ticket metadata and Xray steps for a single issue or a bulk query.

```bash
npm run export:full

# Or pass an issue key directly
node export-full.js ACIOSMAU-123
```

### Metadata-only Export

Exports ticket metadata without Xray steps (no browser required):

```bash
npm run export
# or
node index.js ACIOSMAU-123
```

### Export Steps for a Range

Reads an existing `_tickets.csv`, prompts for a row range, captures steps for those rows, and writes a merged Excel:

```bash
npm run export:range
```

### Merge CSVs to Excel

Merge an existing `_tickets.csv` + `_steps.csv` pair into a styled `.xlsx`:

```bash
npm run merge
```

Merge all CSV pairs in a folder (deduplicates by ticket key):

```bash
npm run merge:folder
```

### Chrome DevTools Protocol Export (advanced)

Connect to a running Chrome instance via CDP to click the Xray "Export → To CSV" button directly:

```bash
# First, launch Chrome with remote debugging enabled
bash start-chrome-debug.sh

# Then run the CDP export
npm run export:steps
```

## Project Structure

```
├── index.js                 # Metadata-only export (REST API)
├── export-full.js           # Full export with Xray steps (Playwright)
├── export-test-sets.js      # Test Set export (recommended)
├── export-range.js          # Range-based step export
├── export-steps-ui.js       # CDP-based UI click export
├── merge-to-excel.js        # Merge a CSV pair to Excel
├── merge-folder.js          # Merge all CSV pairs in a folder
├── login.js                 # Interactive browser login (saves session)
├── setup-auth.js            # Login using existing Chrome profile
├── start-chrome-debug.sh    # Launch Chrome with CDP debugging
├── src/
│   ├── jiraClient.js                    # Jira REST API client
│   ├── xrayClient.js                    # Xray Cloud GraphQL client (optional)
│   ├── csvExporter.js                   # CSV writer helpers
│   └── playwright/
│       ├── auth.js                      # Playwright auth helpers
│       ├── captureSteps.js              # Xray step interception
│       ├── captureTestSetTests.js       # Test Set → Tests interception
│       └── exportSteps.js              # CDP UI-click export helper
├── .env.example             # Environment variable template
└── output/                  # Generated output (gitignored)
```

## Output Format (Excel)

The merged `.xlsx` files contain the following columns:

| Column | Description |
|---|---|
| Test Set Key | Xray Test Set issue key |
| Test Set Summary | Test Set title |
| Test Set Status | Current workflow status |
| Test Key | Individual test issue key |
| Test Summary | Test title |
| Test Status | Test workflow status |
| Test Type | Manual / Automated |
| Step # | Step number within the test |
| Action | Step action description |
| Test Data | Input data for the step |
| Expected Result | Expected outcome |

Ticket-level rows are vertically merged and color-coded for readability.

## Notes

- The `.auth/session.json` file is gitignored. Re-run `npm run login` if your session expires.
- The `output/` directory is gitignored. All generated CSVs and Excel files stay local.
- `src/xrayClient.js` provides a GraphQL-based Xray API client but is not used by default, as it requires Xray Cloud API credentials (Client ID + Secret).
