# Optional language-model interpretation

The assistant always preserves the architecture's safety boundary: language is
translated into a small typed request, and the deterministic scheduling engine
produces every availability, capacity, and optimization result. A model cannot
book, override rules, change authorization, or invent an answer.

The fixed parser runs first. Only low-confidence requests may use the optional
OpenAI-compatible endpoint. Before transmission, known patient names and
service names become allowlisted tokens; email addresses, phone numbers,
government-style identifiers, and unknown capitalized name-like words are
redacted. A response is accepted only if it is one JSON object containing known
intent values and supplied entity tokens. Unknown IDs, extra prose, malformed
numbers, timeouts, and provider errors fall back to the deterministic parser.

The feature requires two independent gates:

```text
LLM_ASSISTANT_ENABLED=true
LLM_ASSISTANT_PHI_APPROVED=true
LLM_ASSISTANT_BASE_URL=https://approved-model-host.example/v1
LLM_ASSISTANT_API_KEY=<server-only key>
LLM_ASSISTANT_MODEL=<approved model/deployment>
LLM_ASSISTANT_TIMEOUT_MS=6000
```

`LLM_ASSISTANT_PHI_APPROVED` must remain false until the client approves the
vendor or self-hosted deployment, BAA, data-use and training terms, retention
and deletion, logging/redaction, region, access controls, incident response,
model/version change process, prompt-injection testing, and production use case.
Tokenization reduces disclosure; it does not replace that approval because
free-form staff text may still contain sensitive context.
