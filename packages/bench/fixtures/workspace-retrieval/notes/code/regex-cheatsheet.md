# Regex cheat sheet (JavaScript and PCRE flavors)

## Building blocks

| Token | Meaning |
| --- | --- |
| `.` | any character except newline |
| `\d` `\w` `\s` | digit, word character, whitespace |
| `\b` | word boundary |
| `^` `$` | start and end of line (with the `m` flag) |
| `*` `+` `?` | zero or more, one or more, optional |
| `{2,4}` | between two and four |
| `*?` | lazy version, matches as little as possible |

## Groups

- `(abc)` captures, `(?:abc)` groups without capturing.
- Named group: `(?<year>\d{4})-(?<month>\d{2})`, then `match.groups.year` in JavaScript.
- Backreference: `(\w)\1` finds doubled letters like "oo".

## Lookaround

A negative lookahead, (?!foo), matches a position only if foo does not follow. Handy for "any line that does not contain TODO": `^(?!.*TODO).*$`.

- Positive lookahead: `\d+(?= dollars)` matches the digits but not the word.
- Lookbehind: `(?<=\$)\d+` matches digits that come right after a dollar sign. Lookbehind is fine in modern JavaScript but missing in very old Safari.

## Patterns I actually reuse

```js
const iso = /^\d{4}-\d{2}-\d{2}$/;
const hex = /#(?:[0-9a-f]{3}){1,2}\b/i;
const trimmed = text.replace(/^\s+|\s+$/g, "");
const words = text.match(/\b[\w']+\b/g) ?? [];
```

Quick email check (not RFC-perfect, which is nearly impossible): `^[^@\s]+@[^@\s]+\.[^@\s]+$`.

## Gotchas

- Greedy `.*` will run across a whole line; use `.*?` or a negated class like `[^"]*`.
- Escape the dot in `\.` or it matches anything.
- The `g` flag makes `lastIndex` sticky on a reused regex literal; recreate it in loops.
- In grep, `-E` gives extended syntax; `-P` gives PCRE with lookarounds.
