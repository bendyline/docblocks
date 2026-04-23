# Third-Party Notices

This file lists the third-party open source software used by DocBlocks.

---

## Fonts

All fonts are self-hosted from Google Fonts (latin subset, WOFF2 format).
Individual license files are located in `packages/react/src/fonts/licenses/`.

| Font               | License     | Copyright                            |
| ------------------ | ----------- | ------------------------------------ |
| Cormorant Garamond | SIL OFL 1.1 | The Cormorant Project Authors        |
| Crimson Text       | SIL OFL 1.1 | The Crimson Text Project Authors     |
| DM Sans            | SIL OFL 1.1 | The DM Sans Project Authors          |
| DM Serif Display   | SIL OFL 1.1 | Adobe (2014-2018), Google LLC (2019) |
| Hanken Grotesk     | SIL OFL 1.1 | The Hanken Grotesk Project Authors   |
| IBM Plex Sans      | SIL OFL 1.1 | IBM Corp.                            |
| Inter              | SIL OFL 1.1 | The Inter Project Authors            |
| JetBrains Mono     | SIL OFL 1.1 | The JetBrains Mono Project Authors   |
| Lora               | SIL OFL 1.1 | The Lora Project Authors             |
| Merriweather       | SIL OFL 1.1 | The Merriweather Project Authors     |
| Oswald             | SIL OFL 1.1 | The Oswald Project Authors           |
| Playfair Display   | SIL OFL 1.1 | The Playfair Display Project Authors |
| PT Serif           | SIL OFL 1.1 | ParaType Ltd.                        |
| Roboto             | SIL OFL 1.1 | The Roboto Project Authors           |
| Source Serif 4     | SIL OFL 1.1 | The Source Serif 4 Project Authors   |

---

## Runtime Dependencies

These packages are bundled with or required at runtime by DocBlocks packages.

| Package                   | Version | License    | Used By                    |
| ------------------------- | ------- | ---------- | -------------------------- |
| @modelcontextprotocol/sdk | 1.28.0  | MIT        | cli                        |
| commander                 | 13.1.0  | MIT        | cli                        |
| monaco-editor             | 0.55.1  | MIT        | react, site                |
| playwright-core           | 1.58.2  | Apache-2.0 | cli                        |
| react                     | 18.3.1  | MIT        | react (peer), site, vscode |
| react-dom                 | 18.3.1  | MIT        | react (peer), site, vscode |
| zod                       | 3.25.76 | MIT        | cli                        |

---

## Development Dependencies

These packages are used during development, testing, and building only. They are
not distributed with DocBlocks.

| Package                                    | Version | License    |
| ------------------------------------------ | ------- | ---------- |
| @commitlint/cli                            | 19.8.1  | MIT        |
| @commitlint/config-conventional            | 19.8.1  | MIT        |
| @eslint/js                                 | 9.39.4  | MIT        |
| @playwright/test                           | 1.58.2  | Apache-2.0 |
| @semantic-release/changelog                | 6.0.3   | MIT        |
| @semantic-release/git                      | 10.0.1  | MIT        |
| @types/chai                                | 5.2.3   | MIT        |
| @types/mocha                               | 10.0.10 | MIT        |
| @types/react                               | 18.3.28 | MIT        |
| @types/react-dom                           | 18.3.7  | MIT        |
| @types/vscode                              | 1.110.0 | MIT        |
| @vitejs/plugin-react                       | 4.7.0   | MIT        |
| @vscode/test-web                           | 0.0.80  | MIT        |
| chai                                       | 6.2.2   | MIT        |
| conventional-changelog-conventionalcommits | 8.0.0   | ISC        |
| eslint                                     | 9.39.4  | MIT        |
| eslint-config-prettier                     | 10.1.8  | MIT        |
| eslint-plugin-react-hooks                  | 5.2.0   | MIT        |
| eslint-plugin-react-refresh                | 0.4.26  | MIT        |
| globals                                    | 15.15.0 | MIT        |
| mocha                                      | 11.7.5  | MIT        |
| multi-semantic-release                     | 3.1.0   | 0BSD       |
| prettier                                   | 3.8.1   | MIT        |
| rimraf                                     | 5.0.10  | ISC        |
| semantic-release                           | 25.0.3  | MIT        |
| tsup                                       | 8.5.1   | MIT        |
| tsx                                        | 4.21.0  | MIT        |
| typescript                                 | 5.9.3   | Apache-2.0 |
| typescript-eslint                          | 8.57.1  | MIT        |
| vite                                       | 6.4.1   | MIT        |

---

## License Texts

### SIL Open Font License 1.1

The majority of the bundled fonts are licensed under the SIL Open Font License,
Version 1.1. The full text of this license is available at:
https://scripts.sil.org/OFL

### MIT License

The majority of npm dependencies are licensed under the MIT License. The full
text is available at: https://opensource.org/licenses/MIT

### Apache License 2.0

TypeScript, Playwright, and related packages are licensed under the Apache
License 2.0. The full text is available at:
https://www.apache.org/licenses/LICENSE-2.0

### ISC License

glob, rimraf, and conventional-changelog-conventionalcommits are licensed under
the ISC License. The full text is available at:
https://opensource.org/licenses/ISC

### 0BSD License (Zero-Clause BSD)

multi-semantic-release is licensed under 0BSD. The full text is available at:
https://opensource.org/licenses/0BSD
