# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Copy a cookie or a local storage item as `name=value` from its row.
- Quick import: paste `name=value` onto the popup, or into the name of a new
  cookie or item, to open it filled in and ready to add. Several pairs open in
  the import panel, set to add rather than replace.
- Local storage import also reads `key=value` lines, and cookie import ignores
  a leading `Cookie:`.

### Changed

- The popup is narrower: 480px wide instead of 780px.
- A form's own button is the only filled button while it is open, and reads
  **Add cookie** or **Add item** for a new one. The footer's **Add** button is
  off until the form is closed, so the two can no longer be confused.

## [1.0.0] — 2026-10-09

First public release.

### Cookies

- Lists every cookie the browser would send to the current tab, including
  parent-domain and `HttpOnly` cookies, with badges for `HttpOnly`, `Secure`,
  `SameSite` and `Partitioned`, and expiry as a countdown or a date.
- Quick edit: clicking a cookie opens it with the value selected, and
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or <kbd>Ctrl</kbd>+<kbd>S</kbd> saves.
- An editor for every attribute the cookies API supports: value, domain, path,
  expiry, `SameSite`, `Secure`, `HttpOnly` and `Partitioned` (CHIPS). Changing
  a cookie's identity replaces it, and the original is restored if the browser
  rejects the change.
- Add, duplicate, copy, delete one, or delete all for the site behind a
  confirmation.
- Export as lossless JSON or a `Cookie` header string, to the clipboard or a
  file; import either back, optionally replacing everything. One unreadable
  cookie refuses the whole paste, and other domains are never written.

### Local storage

- A second tab for the page's `localStorage`, with item sizes and a JSON badge.
- Add, edit, rename, duplicate, delete and clear items; **Format JSON** switches
  a value between indented and one line.
- Export and import as a JSON object, merging or replacing.
- Writes are all or nothing, so a full quota leaves the page as it was, and are
  refused if the tab has moved to another site since it was read.

### Everywhere

- Host access is asked for per site, on demand, from a window of its own;
  installing shows no warning and grants access to no site.
- Filter, keyboard shortcuts throughout, light and dark themes, and the popup
  follows the active tab while open.
- Chrome 119+ and Firefox 128+.
