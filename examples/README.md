# Runnable Examples

The examples exercise the published package APIs rather than importing package internals.

- `odp-service-small` demonstrates configuration-first integration for a small catalog.
- `odp-service-marketplace` demonstrates storage-style handlers and bounded virtual scale.
- `odp-agent-discovery` builds an explicit mock directory from reachable configured Services and
  walks through their discovery responses.
- `odp-service-aep-mpp` exposes an ODP Action that requires AEP authentication followed by an MPP
  payment.
- `odp-service-x402` exposes an ODP Action protected by x402.

Each runnable package includes `.env.example`. Copy it to `.env` to make local configuration
explicit; `.env` remains untracked.

Build and exercise the complete flow with:

```sh
pnpm build
pnpm smoke:examples
```

For an interactive walkthrough, start the two Services in separate terminals and then start the
agent. The Service processes print their discovery URLs and request activity; the agent explains
each discovery stage and prints its protocol responses.

The protected examples use InFlow's sandbox and require credentials. Their README files show the
supporting services and commands needed to complete each Action.
