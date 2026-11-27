# Linear algebra: eigenvalues and eigenvectors

Study notes for the week-8 quiz.

## Definition

For a square matrix A, a nonzero vector v is an eigenvector with eigenvalue lambda if A v = lambda v. The matrix just stretches v (or flips it, if lambda is negative) without changing its direction.

## How to find them

1. Solve the characteristic equation det(A - lambda I) = 0 for lambda.
2. For each lambda, solve (A - lambda I) v = 0 for the null space.

Worked example, A = [[4, 1], [2, 3]].

det([[4 - l, 1], [2, 3 - l]]) = (4 - l)(3 - l) - 2 = l^2 - 7l + 10 = (l - 5)(l - 2).

So lambda = 5 and lambda = 2. For lambda = 5: (A - 5I) = [[-1, 1], [2, -2]], so v = (1, 1). For lambda = 2: [[2, 1], [2, 1]], so v = (1, -2).

## Shortcuts to check answers

- The sum of eigenvalues equals the trace (4 + 3 = 7, and 5 + 2 = 7).
- The product of eigenvalues equals the determinant (12 - 2 = 10, and 5 x 2 = 10).
- A triangular matrix has its diagonal entries as eigenvalues.
- A symmetric real matrix has real eigenvalues and orthogonal eigenvectors.

## Diagonalization

If A has n independent eigenvectors, A = P D P^-1 where P holds the eigenvectors as columns and D is diagonal. Then A^k = P D^k P^-1, which makes powers cheap. This is the trick for Fibonacci in closed form and for Markov chains converging to a steady state (eigenvalue 1).

## Applications I have seen

- PCA: eigenvectors of the covariance matrix are the principal components.
- Google's PageRank: the dominant eigenvector of the link matrix.
- Stability of differential equations: negative real parts mean decay.

Mistake to avoid: a repeated eigenvalue does not always give enough eigenvectors (defective matrices like [[1, 1], [0, 1]] cannot be diagonalized).
