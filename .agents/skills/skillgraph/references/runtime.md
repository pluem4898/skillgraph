# Runtime location

For this repository-local skill, the SkillGraph checkout root is `../../..`
relative to the directory containing SKILL.md. Resolve it to an absolute path
and verify `src/cli.ts` and `package.json` exist before running commands.

Node.js 24+ and installed checkout dependencies are required. An empty checkout
has no imported corpus. Use the README setup instructions; do not claim a skill
is absent because setup or acquisition is incomplete.

For installation in another agent's skill directory, use
`node scripts/install-skill.ts --target ABSOLUTE_SKILLS_DIRECTORY` from this
checkout. The installer writes an explicit runtime pointer in the installed copy.
Copying only SKILL.md does not install the application or its data.
