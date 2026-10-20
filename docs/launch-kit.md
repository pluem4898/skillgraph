# SkillGraph launch kit

## Repository positioning

Description: Complete agent skill discovery, exact source lines, and reproducible token measurements. Optional evidence summaries with real model usage results.

Topics: `agent-skills`, `ai-agents`, `codex`, `context-management`, `token-optimization`, `typescript`, `cli`, `reproducible-research`.

[GitHub topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) help classify repositories. They do not guarantee traffic. Use the prepared PNG for a [social preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) in repository settings.

## Short post

I built SkillGraph to keep every skill name and full description visible, then let an agent read the original source by hash and line.

Its optional evidence summary reduced actual model input by 89.67% on one synthetic inventory task, repeated twice per arm. All four answers matched an independent ZIP oracle. This is a small evidence-delivery pilot, not a universal skill saving.

Code, method, per-run usage and limitations: https://github.com/pluem4898/skillgraph

I would welcome reproductions and cases where overhead costs more than it saves.

## Technical community post

**Title:** SkillGraph keeps complete skill metadata visible and measures token costs

I wanted to reduce context overhead without hiding skills behind a relevance filter. SkillGraph imports a declared pinned scope, enumerates every full name and description, and resolves snapshot-bound handles to exact original sources. It also provides optional views of recorded REA inventory evidence.

The results differ by stage. Offline compact catalog serialization was 48.04% smaller. Against an equally grouped direct-file baseline, a three-task access replay saved only 1.74% in response payload. These are not total model savings.

A separate actual-model experiment used one authored inventory task and two repeats per arm. Raw evidence used 151,573 input tokens per call; summary views used 15,662. Every answer matched the independent oracle. This 89.67% result measures deterministic evidence delivery, not general skill selection or a whole agent workflow.

The repository includes per-run usage, answers, limitations and reproduction instructions. I would appreciate feedback on fair baselines and workloads where complete discovery remains practical.

https://github.com/pluem4898/skillgraph

## No budget outreach plan

| When | Action | Useful signal |
| --- | --- | --- |
| Prepare | Verify the quick start, examples and links | A newcomer completes one import |
| First share | Publish one technical post in a relevant community after checking its rules | Questions and reproduction attempts |
| Demonstrate | Record a 60 to 90 second demo of import, full catalog, exact source and results | Viewers understand what actually runs |
| Follow up | Answer questions and publish reproductions or counterexamples | Independent evidence |
| Review after a week | Inspect actual GitHub traffic and referrers if available | Which explanation attracts useful users |

No paid ads or purchased stars are needed. Avoid unsolicited mass messages and identical promotional posts across many communities. A useful reproduction is more valuable than an unsupported percentage.

## Demo narration

This is SkillGraph. I import a pinned skill repository, enumerate the full names and descriptions, and choose a handle. The source comes back with its original bytes, hash and line coordinates. There is no hidden top-k list. An optional evidence path computes explicit inventory summaries. In one small model pilot, input fell by 89.67%, and all four answers were correct. That result covers one synthetic inventory question. The repository also reports smaller matched baseline savings, context limits and the complete method.

## Keep the claims precise

Use: 89.67% fewer input tokens in one synthetic evidence-delivery task, two repeats per arm.

Avoid: 89.67% fewer tokens for every skill; equal intelligence proven; lossless summaries of every field; all GitHub skills indexed; free unlimited model use; peer-reviewed research.

The Word report stays local and must not be included in a repository release under the current publication instructions.
