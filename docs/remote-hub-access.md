# Remote Hub Access

Remote Hub Visibility is intended for read-only remote checks only.

## Recommended access patterns

- Recommended: Tailscale private network access to the Mission Control host
- Recommended: Cloudflare Tunnel in front of the app with Cloudflare Access policy
- Acceptable: VPN or other private-network-only ingress
- Not recommended: exposing the Next.js app directly to the public internet

## Minimum security checklist

- Require authenticated access for all hub status routes
- Keep workspace-scoped enforcement enabled
- Keep `/api/hub/status` and `/api/hub/status/snapshot` read-only
- Enable HTTPS at the edge or private network layer
- Restrict remote access to approved users or groups
- Configure a hub status signing key if you want signed snapshots:
  - `MC_HUB_STATUS_SIGNING_KEY`

## What must remain disabled

- Remote command execution
- Remote approvals
- Remote task mutation
- Remote config editing
- Remote file editing
- Remote agent triggering
- Public logs
- Public environment or config exposure
- Unauthenticated hub status endpoints

## Rate limiting

Hub visibility endpoints are rate-limited conservatively.

- Default: `30` requests per minute
- Keying: authenticated workspace + actor identity + request IP
- Design target: local and single-instance deployments

For multi-instance deployments, move the limiter to a shared backing store before depending on it for internet-facing enforcement.

## Snapshot safety

The snapshot endpoint is intentionally sanitized.

It includes:

- generated time
- workspace id
- overall PASS/WARN/FAIL
- aggregate counts only
- digest hash
- optional HMAC signature when `MC_HUB_STATUS_SIGNING_KEY` is configured

It does not include:

- raw logs
- stack traces
- local sensitive paths
- environment variables
- tokens, cookies, or API keys
- command output

