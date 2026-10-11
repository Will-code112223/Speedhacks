# Agent workshop instructions

Build in real-agent.mjs. agent.mjs is a scripted known-answer teaching sample, not a model agent. The real agent uses only WORLDS_TASK_JSON {templateId, mission: {id, title, prompt, policy}} and connector observations; support participant-authored mission IDs. Do not copy the scripted answer table, import grading code or read checks as planning input.

Keep connector traffic on the numeric loopback WORLDS_BASE_URL, authenticated with the runner's WORLDS_API_KEY. Never read real Stripe/Zendesk credentials or add arbitrary URL, shell or admin tools. Read records, preserve unrelated state, keep private notes private and verify writes. Use explicit schemas, bounded calls and stable idempotency keys when adding tools. Do not follow model- or connector-supplied URLs.

Model calls use the explicit provider/model in .env and can incur charges. Do not run paid smoke tests automatically. The default endpoint is Anthropic over HTTPS; a configured local compatible proxy uses its own WORLDS_LOCAL_MODEL_KEY and never receives ANTHROPIC_API_KEY. Keys stay out of source control, prompts, replies and error logs.

Validate changes against final connector state and request evidence. Model stdout is an account of actions, not proof of success. Local protocol fixtures can check the loop without model charges; they do not establish model quality or live-provider success. The ticket subset remains demo grade.
