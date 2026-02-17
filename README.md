<div align="center">
  <img src="icon.svg" alt="AI Code Review" width="120" height="120">
</div>

# AI Code Review Comment Formatter

A browser extension for Chrome and Firefox that reformats AI-generated code review comments into clean, collapsible widgets for better readability.

## Features

- **Collapsible comments** — wraps AI review comments into `<details>`/`<summary>` elements so they don't clutter the page
- **Severity badge** — extracts the severity level (🔴 🟠 🟡 🔵 ⚠️) and injects it into the comment header
- **Structured sections** — recognizes Issue (🧐), Suggestion (💡), and Context (📝) sections and organizes them inside the collapsible body

## Installation

### Chrome

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder

### Firefox

1. Clone or download this repository
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…**
4. Select the `manifest.json` file from the repository folder

## How It Works

1. The content script runs on every page at `document_idle`
2. It queries the DOM for comment elements using platform-specific CSS selectors
3. Each comment is checked for the AI review signature — an `<h3>` containing "Severity:" and a known severity icon
4. Matching comments are parsed into structured parts (severity, file path, issue, suggestion, context)
5. The original comment body is replaced with a collapsible `<details>` widget showing the suggestion as the summary and the remaining sections inside
6. A `MutationObserver` re-runs formatting whenever the DOM changes, handling SPA navigation and lazy-loaded comments
