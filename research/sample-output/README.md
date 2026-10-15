# Sample output

What the rebuilt engine is meant to print for a real PR:
[`pr-559.txt`](pr-559.txt), spring-petclinic-microservices #559.

It was assembled by hand from what the research prototypes already compute
(`page-impact`, `field-chain`, `form-guard`). Every `file:line` in it was
re-read at `1d76b00`, and two cited lines were corrected in that pass. It is
the target for stage 2–6. It is not what the shipped CLI prints today: on the
same PR, the CLI returns 127 files with nothing in Tier 1.

Updated after `research/MECHANISMS.md` attacked it: a rule-holes section, the UTC
boundary, the error banner (config repo read), the JMeter and seed-data checks,
and a corrected expectation for the chat. Claims marked "verified" were run on
the real customers-service.

Shape, top to bottom: what changed in behaviour → test first → rule holes → test next →
watch after deploy → do not test (and why) → could not see → who to ask →
trust. Each item to test is page → section → field → do → expect → why.
Effort is counted in test cases, never in hours.
