# Working on Access Walk

This is a fresh hackathon audit engine that must plug into Cavioo's existing funnel, live browser view, finding bubbles and screen-by-screen report. The public engine must remain runnable without Cavioo. Existing Cavioo components are reused inside the private Cavioo app; do not copy that private source, prompts, production data or credentials into this public repository.

Standalone proofs must not call Cavioo production services or endpoints. Keep the concrete private-component mapping in the private integration plan; public documentation can describe the roles to connect.

- Required product direction: preserve Cavioo's existing layout, components, design tokens, labels and interaction patterns. Use the actual components in the Cavioo host, rather than drawing replacements. The current standalone green interface is an engineering test harness, not the approved product design. Follow docs/CAVIOO-COMPATIBILITY.md before further interface work.
- Current work is paused for this compatibility plan update. Do not treat documentation as proof that the Cavioo connection is implemented, or resume a redesign while the pause is in effect.

- Explain changes in plain English, with a concrete example.
- Current owner instruction: no model-credit spending. A key is not permission. Keep live launch disabled until the owner separately approves a bounded batch.
- For retained runs, preserve original actions, images, navigator notes and screen-reader output. Analysis and review read originals independently; review also reads the exact analyst claim. An explicit confirmed Cavioo discard must apply Cavioo's declared deletion behaviour to the linked run, including engine evidence; never keep a hidden evidence archive after that deletion promise. Ordinary Stop retains its separate evidence-preserving meaning.
- A keyboard or VoiceOver claim requires an actual test. A screenshot, browser metadata or a robot limitation cannot replace that evidence.
- Save uncertainty. Finishing a run never accepts an unchecked finding. Reopening evidence never starts paid work.
- Real VoiceOver requires a supported Mac desktop session and normal system permissions. Do not bypass operating-system security controls. Keep virtual-reader examples labelled as simulations.
- Run `npm run check` and `npm run build`. Use the controlled browser proofs where relevant. A real screen-reader proof remains incomplete until its actual commands and speech are captured.
- Work on `codex/` branches and use pull requests. Stage only named paths. Do not merge without Adriano's instruction.
- Keep `.env`, `spend-approval.json`, `data/`, `output/` and credentials out of Git. Show measured costs rather than estimates presented as results.
- Deliveries state Impact on the system, Impact on the UX and Still pending. Identify incomplete proofs and the person who moves next.
