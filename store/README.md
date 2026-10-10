# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste, and the images to
upload. The package itself comes from `bun run build`
(`dist/<name>-<version>.zip`; see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing)).

## Store listing

**Name** and **summary** come from `src/manifest.json`; change them there.

- Name: `Cookie & LocalStorage Editor by HomieLab`
- Summary: `Quick edit cookies and localStorage of the current site: view, add, delete, import and export as JSON. No tracking.`
- Category: Developer Tools
- Language: English

**Description**

```
Cookie & LocalStorage Editor by HomieLab is a fast, private way to quick edit
the cookies and localStorage of the page you are on: view, add, edit, delete,
import and export them without leaving the tab. Two tabs, one click apart.

It shows every cookie the browser would send to the current tab — cookies set
on parent domains, HttpOnly cookies the page itself cannot read — and lets you
create, change or remove any of them in a couple of clicks. Works in Chrome,
Edge, Brave and Opera.

BUILT FOR DEVELOPING

Set a cookie to test a feature branch. Change one value and reload. Clear the
cookies a site left behind when you want the page to behave as if it had never
met you. No console incantations, no reloading between attempts.

BUILT FOR PRIVACY

See what a site has stored about you, then decide what stays. "Delete all"
clears a site in one step, behind a confirmation.

EVERY ATTRIBUTE, IN ONE EDITOR

Value, domain, path, expiry, SameSite, Secure, HttpOnly and Partitioned
(CHIPS). Expiry presets cover the usual cases and a precise date covers the
rest. Duplicate a cookie to try a second value side by side.

LOCAL STORAGE, TOO

The Local storage tab lists the page's localStorage with each item's size.
Click an item to edit its value straight away, format JSON values to read
them, rename keys, and save with Ctrl + Enter. Writes are all or nothing: if
the site's storage is full, nothing is half-written.

IMPORT AND EXPORT

Export cookies as lossless JSON, or as a Cookie header string you can paste
into a request or a test fixture, and local storage as a JSON object. Import
them back. A paste with one unreadable cookie is refused as a whole, and
cookies for other domains are never written.

KEYBOARD FIRST

  1 / 2        Cookies / Local storage
  /            filter the list
  N            new cookie or item
  E / I        export / import
  Ctrl + Enter save
  Esc          close

PRIVATE BY DESIGN

No background process, no network access, no analytics, no telemetry. Nothing
you see or edit ever leaves your computer. Installing it grants no access to
any website: the first time you open it on a site, it asks for that site only,
or all sites if you prefer, and you can take access back at any time.

Open source, MIT licensed. Like it? Support it on Ko-fi:
https://ko-fi.com/homielab
```

**Graphic assets** (all in this folder)

| Asset                      | File                                                  |
| -------------------------- | ----------------------------------------------------- |
| Store icon (128x128)       | `../src/icons/icon-128.png`                           |
| Screenshots (1280x800)     | `screenshots/01` to `05`, in order                    |
| Small promo tile (440x280) | `promo-small.png` (without one, the item ranks lower) |
| Marquee (1400x560)         | `promo-marquee.png` (optional; used only if featured) |

## Privacy practices

**Single purpose**

```
Cookie & LocalStorage Editor lets the user view, create, edit and delete the
data the website they are currently visiting stores in their browser — its
cookies and its local storage — for testing their own software and managing
their own privacy. It operates only on the active tab's site.
```

**Permission justifications**

`cookies`

```
The core of the extension: listing, creating, editing and deleting the cookies
of the site in the active tab. Without it no cookie can be read or written.
```

`activeTab`

```
Lets the popup read the address of the tab the user opened it on, so it knows
which site's cookies and storage to show and which site to offer access to.
```

`scripting`

```
A page's localStorage exists only inside the page, so the Local storage tab
runs two small functions bundled with the extension in the active tab's top
frame with scripting.executeScript: one reads the items, one applies the
user's edit. They run only when the user opens or edits the Local storage tab,
only on sites the user has allowed, and send nothing anywhere.
```

Host permission (`optional_host_permissions: <all_urls>`)

```
Not granted at install. The cookies API and scripting only work on hosts the
extension may access, so the first time the popup opens on a site it offers
"Allow on this site" (that host and its parent domains, listed before the
browser's own prompt) or "Allow on all sites". <all_urls> is declared only so
that any site can be requested; access can be revoked at any time.
```

**Remote code:** No. Everything is bundled; the functions run in pages are part
of the package and passed to `scripting.executeScript` as functions, not code
strings. There is no `eval`, no `fetch` and no remote script.

**Data usage:** declare none of the data types. The extension shows cookies and
storage to the user locally and never collects or transmits them. Tick all
three certifications (no selling or transfer of user data, no unrelated use,
no creditworthiness or lending use).

**Privacy policy URL:** the published `PRIVACY.md`.

## Distribution

- Visibility: Public. Regions: all.
- No ads, no in-app purchases.
- Publisher (account settings): HomieLab, contact email `contact@homielab.com`
  (verify it in the dashboard), website `https://homielab.com`.
- Homepage URL: `https://homielab.com`. Support URL: the GitHub repository's
  issues page, or `mailto:contact@homielab.com`.

## Firefox

The same zip works on addons.mozilla.org. The add-on ID is
`cookie-editor@homielab.com` (`browser_specific_settings.gecko.id`); keep it fixed
once published, since Firefox treats a new ID as a different add-on.

On the AMO listing, set **Contributions URL** to https://ko-fi.com/homielab (Ko-fi is one of the
platforms AMO accepts); it shows as a donate button on the add-on page.
