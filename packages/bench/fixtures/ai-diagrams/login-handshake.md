# How sign-in works

## The sign-in exchange

When a person signs in, the browser sends their email and password to the API server. The API server asks the identity service to check the password. The identity service replies with the account record when the password matches. The API server then creates a session and returns a session token to the browser, which stores it in a secure cookie for later requests.

## Troubleshooting

If sign-in fails repeatedly, clear the site's cookies and try again before contacting support.
