# Runnable Examples

The examples exercise the published package APIs rather than importing package internals.

- `odp-service-small` demonstrates configuration-first integration for a small catalog.
- `odp-service-marketplace` demonstrates storage-style handlers and bounded virtual scale.
- `odp-agent-discovery` builds an explicit mock directory from reachable configured Services and
  walks through their discovery responses.

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
