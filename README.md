# achilles

the platform for flexible productionization on the home server: one prompt builds an agentic product and deploys it, connected to shared services.

goal: "the dream" in ~/me/fun/ween/posts/self-healing.md. first test prompt: "build braintrust locally. ingest all of my agent traces from X, build analytics and a judge pipeline, surface all urgent results through my messaging agent. add a dashboard for judge verdicts".

planned pieces (from the gap analysis, not built yet):
- persistent product deploy on neenerair
- a read-only trace feed over zeta sessions
- one shared judge runner
- a messaging adapter to the messaging agent
- a playbook so the zeta orchestrator can find and use all of this

dependencies: zeta (~/me/fun/zeta), homelab (host services on neenerair).
design notes (in progress): ~/.zeta/scratch/next-phase/dream-braintrust-gaps.md, ~/.zeta/scratch/next-phase/design-dream-platform.md
