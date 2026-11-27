---
tags: [sql, reference, databases]
---

# SQL cheat sheet

Working reference built up while doing the database course exercises and a few personal projects (a reading tracker and a household budget database). Examples use a small schema: `customers(id, name, country, created_at)`, `orders(id, customer_id, total_cents, status, created_at)` and `order_items(order_id, sku, qty, price_cents)`.

## The logical order of a SELECT

People write SELECT first, but the database evaluates it in a different order, which explains most "why can't I use my alias here" errors:

1. FROM and JOIN
2. WHERE (filters rows, cannot see aggregates or select aliases)
3. GROUP BY
4. HAVING (filters groups, can see aggregates)
5. SELECT (aliases are born here)
6. DISTINCT
7. ORDER BY (can see aliases)
8. LIMIT / OFFSET

So `WHERE total > 100` works on a column, but filtering on `SUM(total)` needs `HAVING SUM(total_cents) > 10000`.

## Joins

```sql
SELECT c.name, o.id, o.total_cents
FROM customers AS c
INNER JOIN orders AS o ON o.customer_id = c.id;

-- every customer, even those with no orders
SELECT c.name, COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name;
```

An INNER JOIN keeps only matching rows. A LEFT JOIN keeps every row from the left table and fills missing right-side columns with NULL. A common bug: putting a filter on the right table in the WHERE clause (`WHERE o.status = 'paid'`), which silently turns the LEFT JOIN into an inner join. Move that condition into the ON clause instead.

CROSS JOIN produces every combination (a calendar of dates times a list of products, for example). A self join needs two aliases, such as finding people who share a city.

## Aggregates and NULL

- `COUNT(*)` counts rows, `COUNT(col)` counts non-NULL values, `COUNT(DISTINCT col)` counts unique ones.
- `SUM`, `AVG`, `MIN`, `MAX` ignore NULLs.
- Comparing with NULL never works using `=`; use `IS NULL` or `IS NOT NULL`.
- `COALESCE(discount, 0)` returns the first non-NULL argument.
- `NULLIF(a, b)` returns NULL when the two are equal, which is a neat trick to avoid division by zero: `total / NULLIF(count, 0)`.

## Window functions

Window functions compute something across related rows without collapsing them the way GROUP BY does. ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) numbers rows within each group, newest first. That makes "latest order per customer" easy:

```sql
SELECT *
FROM (
  SELECT o.*,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
  FROM orders o
) ranked
WHERE rn = 1;
```

Other window functions worth remembering:

- `RANK()` leaves gaps after ties (1, 2, 2, 4); `DENSE_RANK()` does not (1, 2, 2, 3).
- `LAG(total_cents) OVER (ORDER BY created_at)` reads the previous row; `LEAD` reads the next.
- Running total: `SUM(total_cents) OVER (ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`.
- `NTILE(4)` splits rows into quartiles.

Window functions run after WHERE and GROUP BY, which is why the example above needs a subquery: you cannot filter on `rn` in the same level where it is defined.

## Common table expressions

```sql
WITH paid AS (
  SELECT customer_id, SUM(total_cents) AS spent
  FROM orders
  WHERE status = 'paid'
  GROUP BY customer_id
)
SELECT c.name, paid.spent
FROM paid
JOIN customers c ON c.id = paid.customer_id
ORDER BY paid.spent DESC
LIMIT 10;
```

A CTE reads like a named step. Recursive CTEs walk trees (org charts, category parents): a base query, `UNION ALL`, then a query that joins back to the CTE itself. Always include a termination condition or a depth column.

## Dialect differences I have tripped over

Postgres has ILIKE for case-insensitive matching; MySQL's default collation already ignores case, and SQLite's LIKE is case-insensitive for ASCII only. String concatenation is `||` in Postgres and SQLite but `CONCAT()` in MySQL. Getting only N rows is `LIMIT n` in all three but `TOP n` in SQL Server and `FETCH FIRST n ROWS ONLY` in the standard. Auto-incrementing keys are `SERIAL` or `GENERATED ... AS IDENTITY` in Postgres, `AUTO_INCREMENT` in MySQL, and `INTEGER PRIMARY KEY` in SQLite. Boolean columns in SQLite are really integers 0 and 1.

Date arithmetic is the messiest. Postgres: `created_at > now() - interval '7 days'`. MySQL: `created_at > NOW() - INTERVAL 7 DAY`. SQLite: `created_at > datetime('now', '-7 days')`.

## Indexes and EXPLAIN

An index helps when the WHERE clause or join key matches its leftmost columns. A composite index on `(customer_id, created_at)` serves queries filtering by customer, and by customer plus date range, but not by date alone. Wrapping an indexed column in a function (`WHERE lower(email) = ...`) defeats the index unless there is a matching expression index. Put `EXPLAIN` (or `EXPLAIN ANALYZE` in Postgres) in front of a slow query and look for sequential scans on large tables, row estimates that are wildly wrong, and sorts spilling to disk.

Too many indexes slow down writes, since every INSERT must update each one. I try to add them only after seeing a real slow query.

## Transactions

```sql
BEGIN;
UPDATE accounts SET balance_cents = balance_cents - 5000 WHERE id = 1;
UPDATE accounts SET balance_cents = balance_cents + 5000 WHERE id = 2;
COMMIT;   -- or ROLLBACK;
```

ACID: atomic, consistent, isolated, durable. The default isolation level in Postgres is READ COMMITTED; SERIALIZABLE is the strictest and may abort transactions that need a retry.

## Upserts

Postgres and SQLite: `INSERT ... ON CONFLICT (sku) DO UPDATE SET qty = excluded.qty;`. MySQL: `INSERT ... ON DUPLICATE KEY UPDATE`.

## Habits to keep

- Select named columns in application code, not `SELECT *`.
- Store money as integer cents, never floats.
- Use parameterized queries to avoid SQL injection; never glue strings.
- Name constraints so error messages mean something.
- Test destructive statements by running the SELECT version with the same WHERE first.

Left to learn: partial indexes, lateral joins, and `GROUPING SETS` for subtotal rows.

## Worked problems from the exercises

A few of the exercise questions that took me more than one attempt, with the reasoning rather than only the answer.

**Customers who have never ordered.** The tempting answer is a NOT IN subquery, but NOT IN returns nothing at all if the subquery contains a single NULL. The safe alternatives are NOT EXISTS or a LEFT JOIN with `WHERE o.id IS NULL`. I use the anti-join form because it reads naturally once the join pattern is familiar, and the planner usually treats both identically.

**Second highest order total.** Using `ORDER BY total_cents DESC LIMIT 1 OFFSET 1` is fine for the simple case but breaks when there are ties and the question means "the second highest distinct value". DENSE_RANK in a subquery handles both interpretations explicitly, so I prefer it.

**Month-over-month growth.** Group orders by month with `date_trunc('month', created_at)` in Postgres, then use `LAG` over the month ordering and compute `(this - previous) * 100.0 / NULLIF(previous, 0)`. The multiplication by 100.0 (a decimal) matters because integer division silently truncates to zero in most databases.

**Deduplicating rows.** Assign `ROW_NUMBER() OVER (PARTITION BY email ORDER BY created_at)` and delete everything with a number above 1. In Postgres this can be done by deleting by `ctid`, in MySQL by joining the table to itself.

**Pivoting rows into columns.** Conditional aggregation is the portable way: `SUM(CASE WHEN status = 'paid' THEN total_cents ELSE 0 END) AS paid_total`. Postgres also offers `FILTER (WHERE status = 'paid')` which is tidier.

## Normalization in one paragraph

First normal form means each cell holds one value and rows are unique. Second means every non-key column depends on the whole key. Third means non-key columns depend only on the key, not on each other (store the city's name once, not in every customer row). I normalize to third form by default and denormalize deliberately, only for read performance on reporting tables, and then document why.
