# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is a MediaWiki user script that creates dynamic forms based on JSON configuration. The script:

1. **Loads configuration** from a MediaWiki page (`User:L235/form-config.json`) containing form definitions
2. **Renders forms dynamically** on configured pages using OOJS-UI and MediaWiki APIs
3. **Processes submissions** by appending formatted wikitext to target pages using template substitution

### Key Components

- **Configuration loading**: Uses MediaWiki API to fetch JSON form definitions
- **Form rendering**: Creates accessible HTML forms with various field types (text, textarea, dropdown, checkbox, radio, heading, static HTML)
- **Template integration**: Outputs submitted data as MediaWiki template calls with parameter mapping
- **Cross-browser compatibility**: Includes CSS.escape polyfill for older browsers

### Field Types Supported

The script supports text, textarea, dropdown, checkbox, radio, heading, and static HTML fields with validation, default values, and accessibility features.

### Data Flow

1. Script loads on MediaWiki page
2. Fetches form configuration from JSON page
3. Matches current page to form definition
4. Renders form with accessibility attributes
5. On submission, validates required fields and appends template call to target page

## Development Notes

- This is a client-side MediaWiki user script (no build process)
- Uses MediaWiki APIs and OOJS-UI library
- Includes security measures: HTML escaping, template parameter encoding, CSS.escape polyfill
- Form configuration lives in `User:L235/form-config.json` on the wiki