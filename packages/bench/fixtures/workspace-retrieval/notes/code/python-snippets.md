# Python snippets I keep looking up

## Comprehensions

A comprehension replaces a loop plus append with a single bracketed expression. The pattern is `[expr for item in things if condition]`.

```python
squares = [n * n for n in range(10) if n % 2 == 0]   # [0, 4, 16, 36, 64]
lookup = {w: len(w) for w in ["apple", "fig", "banana"]}
unique_lengths = {len(w) for w in words}
```

Generator expressions use parentheses and are lazy: `sum(n * n for n in range(1_000_000))` never builds the list.

## Dataclasses

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)
class Book:
    title: str
    year: int
    tags: list[str] = field(default_factory=list)
```

Mutable defaults must use `default_factory`, otherwise every instance shares one list.

## pathlib instead of os.path

```python
from pathlib import Path

for p in Path("notes").rglob("*.md"):
    text = p.read_text(encoding="utf-8")
    print(p.stem, len(text.split()))
```

## Sorting and grouping

```python
from collections import Counter, defaultdict
from itertools import groupby

people.sort(key=lambda p: (p.city, -p.age))
counts = Counter(text.lower().split()).most_common(5)

by_city = defaultdict(list)
for p in people:
    by_city[p.city].append(p)
```

`groupby` only groups adjacent items, so sort by the same key first.

## Context managers and errors

```python
import json
try:
    with open("settings.json") as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
```

Rule of thumb: catch the narrowest exception that makes sense, never a bare `except:`.

## Virtual environments

`python -m venv .venv`, then `source .venv/bin/activate`, then `pip install -r requirements.txt`.
