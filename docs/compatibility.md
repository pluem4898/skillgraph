# Agent compatibility

SkillGraph is a provider-independent CLI with an Agent Skills entry point. Its
core commands do not call a model API. Any agent with filesystem and shell tools
can read the instructions and run the same Node.js 24+ CLI. A chat-only model
without those tools cannot use the local application merely by receiving a link.

## Install for your agent

Clone the full repository, run `npm ci --ignore-scripts`, and initialize the
desired corpus as described in the README. Keep this checkout: it contains the
runtime and local database. Then install the skill into your host's documented
skill directory:

```text
node scripts/install-skill.ts --target ABSOLUTE_SKILLS_DIRECTORY
```

The installer creates `skillgraph/` inside that directory, copies the same
provider-neutral instructions and references, and writes a runtime pointer to
the retained checkout. It refuses to overwrite an existing destination. It does
not edit host settings, install dependencies, import a corpus or authenticate an
AI account. Moving the checkout requires reinstalling the skill pointer.

| Host | Installation guidance | Verification status |
| --- | --- | --- |
| Codex | Repo discovery uses `.agents/skills`; personal locations follow current host docs | Real model pilot and local CLI checks completed; cross-project installed invocation not yet measured |
| Claude Code | Install into a documented `.claude/skills` project or personal directory | Instructions and installer prepared; model workflow not tested |
| Gemini CLI | Use its documented skills discovery location or installation mechanism | Instructions and installer prepared; model workflow not tested |
| Other tool-capable agents | Register the skill folder or provide SKILL.md and runtime reference explicitly | Host integration and model behavior not tested |

Automatic selection depends on the host's discovery, description matching,
permissions and configuration. Installing a skill does not force all tasks
through SkillGraph or replace a host's built-in skill loader. The complete
catalog guarantee applies to the declared imported SkillGraph corpus, not every
skill installed elsewhere on the machine.

The previous 89.67% actual-input result is from one synthetic evidence task run
with Codex CLI. It is not a measured saving on Claude, Gemini or every agent.

## Primary references

- [Agent Skills specification](https://agentskills.io/specification)
- [Codex skills discovery](https://learn.chatgpt.com/docs/build-skills)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Gemini CLI skills](https://geminicli.com/docs/cli/using-agent-skills/)
