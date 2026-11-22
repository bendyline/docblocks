# Loan amortization: formula, worked table, and what it means

I wanted to understand the numbers on a mortgage statement properly, so I built the table by hand in a spreadsheet and checked the first rows with a calculator. This note collects the formula, the example, and the lessons.

## What amortization means

An amortizing loan is repaid with equal payments over a fixed term. Each payment covers that month's interest first; whatever is left reduces the principal. Because interest is charged on the remaining balance, the interest share falls and the principal share rises as the loan ages, even though the payment never changes.

## The payment formula

For a loan of principal P, monthly interest rate r (annual rate divided by 12), and n total monthly payments:

M = P x r / (1 - (1 + r)^-n)

Equivalently M = P x [r(1 + r)^n] / [(1 + r)^n - 1].

Each month's accounting:

1. Interest = balance x r
2. Principal paid = M - interest
3. New balance = old balance - principal paid

## Worked example: $300,000, 30 years, 6% APR

- P = 300,000
- r = 0.06 / 12 = 0.005
- n = 30 x 12 = 360
- (1.005)^360 is about 6.0226, so 1 - 1/6.0226 = 0.83396
- M = 300,000 x 0.005 / 0.83396 = 1,500 / 0.83396 = $1,798.65

First rows of the table:

| Month | Payment | Interest | Principal | Balance |
| --- | --- | --- | --- | --- |
| 1 | 1,798.65 | 1,500.00 | 298.65 | 299,701.35 |
| 2 | 1,798.65 | 1,498.51 | 300.14 | 299,401.21 |
| 3 | 1,798.65 | 1,497.01 | 301.64 | 299,099.57 |
| 180 | 1,798.65 | about 1,066 | about 733 | about 213,100 |
| 360 | 1,798.65 | 8.95 | 1,789.70 | 0.00 |

(The month 180 row is rounded; I took it from the spreadsheet rather than by hand.)

In month 1, $1,500.00 of the $1,798.65 payment is interest and only $298.65 reduces principal. That is 83% of the first payment going to the lender's return. After 5 years (60 payments) the balance has only fallen to about $279,200, a reduction of roughly $20,800, though I will have paid about $107,900 in total.

Total over the whole life: 360 x 1,798.65 = $647,514, so the total interest is about $347,514, more than the house loan itself.

The halfway point in payments is not the halfway point in balance. At month 180 (15 years in) about 71% of the original principal is still owed.

## Comparison: 15-year at a lower rate

A 15-year loan at 5.5% on the same $300,000 comes to roughly $2,451 a month. Total paid: about $441,200, total interest about $141,200. That saves around $206,000 in interest against the 30-year, in exchange for about $650 more per month. The lower rate (shorter loans usually carry lower rates) contributes to the savings, but most of the difference is simply time.

| Loan | Monthly payment | Total interest |
| --- | --- | --- |
| 30-year, 6.0% | $1,798.65 | about $347,500 |
| 15-year, 5.5% | about $2,451 | about $141,200 |

## Extra principal payments

Because interest is calculated on the balance, any extra payment applied to principal in the early years removes a month's worth of future interest for every dollar. Adding $200 a month to the 30-year example at 6% pays the loan off in about 23 years and 2 months instead of 30 and saves roughly $91,000 of interest. The rule I find easy to remember: one extra payment per year (13 instead of 12) takes about 4 to 5 years off a 30-year loan.

Confirm with the lender that extra money is applied to principal and not to the next month's payment, and check for prepayment penalties (rare on US mortgages now).

## Spreadsheet formulas

- Payment: `=PMT(rate/12, years*12, -principal)`
- Interest in period k: `=IPMT(rate/12, k, years*12, -principal)`
- Principal in period k: `=PPMT(rate/12, k, years*12, -principal)`
- Balance after k payments: `=principal*(1+r)^k - M*((1+r)^k - 1)/r`

Cumulative interest between payments a and b: `=CUMIPMT(rate/12, n, principal, a, b, 0)`.

## APR vs interest rate

The quoted rate sets the monthly interest. The APR folds in some fees (points, origination fees), so it is a better comparison tool across lenders but not what the payment is based on. Escrow for property tax and insurance is added on top of principal and interest and is not part of the amortization schedule, which is why the bank's monthly bill is higher than the formula result.

## Adjustable-rate loans

An ARM such as 5/1 keeps a fixed rate for five years, then adjusts annually based on an index plus a margin, within caps (commonly 2/2/5: 2 points at first adjustment, 2 per year after, 5 over the life). The schedule is re-amortized at each reset over the remaining term.

## Lessons

1. Early payments are mostly interest, so the first years build equity slowly. Selling after three years often nets little principal reduction.
2. Term length matters more than a small rate difference.
3. Refinancing resets the clock; compare the remaining term, not only the rate.
4. Car loans and student loans follow the same math, with shorter terms.

Next step: build the same table for a credit card balance to see the cost of paying only the minimum.

## Extra: biweekly payments and rate sensitivity

Splitting the monthly payment in half and paying every two weeks yields 26 half-payments, which is the same as 13 full monthly payments a year. That is the "one extra payment a year" effect without feeling it as a big bill. Some servicers charge a fee to set it up; it is free to do manually by sending one extra twelfth each month.

Rate sensitivity is more striking than I expected. On the same $300,000, 30-year loan, the payment at 5% is about $1,610.46, at 6% it is $1,798.65, and at 7% it is about $1,995.91. Each full percentage point is roughly $190 a month, and over 360 payments it adds close to $70,000 in interest. A quarter-point difference, like 6.00% versus 6.25%, is worth about $50 a month, which is why paying discount points is only worth it if the borrower will keep the loan long enough to break even. A simple break-even: divide the cost of the points by the monthly saving. If a point costs $3,000 and saves $55 a month, break-even is about 55 months, so a person who expects to move or refinance in four years should not buy it.

Remember also the opportunity cost angle. Paying down a 6% mortgage is a guaranteed 6% return, but if the household has a better use of money (an employer match, or paying off a 22% credit card), the order of priority should follow the interest rate. My own ordering: employer match first, high-interest debt second, emergency fund third, then compare extra mortgage principal against investing.
