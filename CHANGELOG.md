# Changelog

All notable changes to this project are documented in this file. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-15

### Added

- REST API routes for products, categories, orders, and authentication, backed by PostgreSQL.
- JWT-based registration, login, and authenticated access to protected routes.
- Zod validation for authentication, product data, route IDs, and order status.
- GitHub Actions workflows for backend tests, deployment verification, and scheduled production smoke checks.

### Changed

- Added Helmet security headers, an explicit CORS origin allowlist, proxy awareness, and a 16 KB JSON request-body limit.
- Limited failed login attempts and registration requests to 10 per 15-minute window per client IP, with standard rate-limit headers; successful logins are excluded from the login limit.

### Fixed

- Coordinated concurrent login attempts so parallel requests cannot bypass the per-email failure threshold; stale or reused reservations cannot issue a JWT.

### Security

- Added PostgreSQL-backed login-attempt tracking keyed by HMAC of normalized email, with a 60-second block after 10 failed attempts and reset after successful authentication.
- Required a separate `LOGIN_ATTEMPT_SECRET`; authentication fails closed when login-attempt storage is unavailable.
- Kept login responses generic for unknown accounts and incorrect passwords to avoid disclosing account existence.
