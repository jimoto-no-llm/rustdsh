# dsh-mobile-maxxing

> [日本語の README はこちら](README.md)

Make the DeepSeek Harness Web UI useful on phones and tablets without changing the stock desktop experience.
The release contains three independent components: mobile UX and notifications, mobile Markdown tables, and an optional Japanese locale.

**[v1.0.0 release](https://github.com/kuraneko1/dsh-mobile-maxxing/releases/tag/v1.0.0)** · **[Japanese release notes](RELEASE-NOTES-v1.0.0.md)**

## Install all three components

```sh
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-mobile-maxxing/main/scripts/install-mobile-bundle.mjs | node --input-type=module
```

The installer targets the `web` profile by default. Restart DSH and reload the browser after installation.
Set `DSH_PROFILE` to use another profile. `DSH_BUNDLE_TAG`, `DSH_LOCALE_REF`, and `DSH_MD_VERSION` pin the component versions independently.

To install only the mobile package:

```sh
dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing
```

## Highlights

- Installable PWA, offline app shell, safe-area and keyboard-aware mobile layouts
- In-app banners while visible and Web Push while backgrounded or closed
- Request-ID turn correlation, per-device subscriptions, parallel delivery with deadlines, and subscription recovery
- HTTPS-only push transport with validation of every DNS answer and no redirect following
- Per-browser theme, typography, chat, permission, and notification settings without changing shared Host settings
- Standalone mobile Markdown table styling with a desktop no-op
- Optional Japanese UI covering 65 namespaces and 2915 keys with zero English fallbacks

HTTPS or localhost is required for the service worker and Web Push. Enable notifications in **Settings → Mobile** and use the test action to verify the browser and OS configuration.

## Documentation and development

- [Detailed English usage](packages/dsh-mobile-maxxing/docs/USAGE.en.md)
- [Japanese usage](packages/dsh-mobile-maxxing/docs/USAGE.ja.md)
- [Development notes](CONTRIBUTING.md)
- [v1.0.0 release notes](RELEASE-NOTES-v1.0.0.md)

```sh
npm test
npm run test:locale
npm run check:locale
npm run check:locale:generated
```

Use the [release command](README.md#リリース). It requires a complete locale and attaches only the four current artifacts, not older files retained in `dist/`.

## Contributors

- [@kuraneko1](https://github.com/kuraneko1), including commits under `_ryu15_`
- [@AliceSaikawa](https://github.com/AliceSaikawa)
- Everyone who contributed code review and verification

## License

MIT. See [LICENSE](LICENSE).
