# Security

## What Teslon does with your code

The engine (`@teslon/core`) reads files and runs `git`. It makes no network
calls, and a test in the suite fails the build if it ever imports one.

The CLI's only outbound requests are to your own git host, to resolve a pull
request you asked it to resolve, using a token you supplied. Nothing is sent
anywhere else. There is no telemetry, and there will not be.

## Reporting a vulnerability

Open a private security advisory on the repository. Please do not open a
public issue for anything exploitable.

## Handling of secrets

Teslon reads whatever is in the working tree, which can include `.env` files
and credentials. It does not copy them, upload them, or include their values
in its output — only the fact that a file changed. Report anything that
contradicts this as a vulnerability, not a bug.
