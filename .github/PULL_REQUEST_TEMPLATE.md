<!--
What this project asks for, which CONTRIBUTING.md explains and this repeats
because nobody reads a second file while opening a pull request:

  - Say what you measured, not what you expect. "Fixes the leak" is a claim;
    "12 of 12 forms issued no request, measured in the E2E harness" is evidence.
  - A guard that always passes also passes. Watch a new check fail before
    trusting it, and say so.
  - Comments explain WHY. The code already says what.
  - No Claude session links anywhere (#179).
-->

## What this changes

<!-- One or two sentences. The problem first, the fix second. -->

## Why

<!-- The reasoning a reader cannot get from the diff. If this fixes an issue,
     "Closes #N" goes here. -->

## How it was verified

<!-- Concrete. Which commands, which numbers, which cases.
     If a new test is meant to catch a regression, say that you saw it fail
     against the old behaviour. If something could not be verified, say that
     too — an honest gap is worth more than a confident gap. -->

- [ ] `npm run lint`, `npm run build`, `npm test`
- [ ] E2E files covering the changed paths (`npm run test:e2e`) — **CI cannot run these**, they only run by hand
- [ ] Any new check was watched failing before being trusted
