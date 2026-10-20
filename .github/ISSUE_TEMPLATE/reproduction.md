---
name: Reproduction or counterexample
about: Share measured usage, correctness, or a case where overhead outweighs savings
title: "[Experiment] "
labels: ""
assignees: ""
---

## Task and scope

Describe the task, corpus revision and which feature you tested: catalog transport, source reads or evidence views.

## Fair comparator

Describe both methods. Did both reuse discovery and receive the same required source/reference content?

## Environment

OS, Node version, SkillGraph commit, requested model, reasoning settings, CLI version and number of independent tasks/repeats.

## Results

Report each arm's actual input/output/cached usage if measured. Otherwise label counts as offline response tokens. Include every failure and retry. Describe the independent correctness check and all answer failures.

## Reproduce

Provide minimal commands and a public or authored fixture. Do not attach credentials, private source files, executable-derived private evidence or personal information.
