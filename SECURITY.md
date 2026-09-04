# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.9.x   | Yes       |
| 0.1.x   | No        |

The latest commit on `main` receives security fixes while 1.0 is being
prepared.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's
[private vulnerability report](https://github.com/DanyloNikulin/hornbook/security/advisories/new)
and include the affected version, impact, reproduction steps and any proposed
mitigation. Remove lesson content, recordings, API keys and local paths from
the report.

You should receive an acknowledgement within seven days. Confirmed issues are
fixed on supported versions and disclosed after a release is available.

Hornbook is a single-owner application. Hosted mode must use its password or
an access proxy; it is not a multi-user authentication system.
