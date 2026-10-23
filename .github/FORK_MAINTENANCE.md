# Fork maintenance contract

This contract applies only to `leether/openclaw`. It does not authorize changes
to the upstream repository, production systems, or package releases.

The fork owner authorized a replacement for upstream-only review services.
ClawSweeper and the upstream App-backed labeler are not applicable when their
Apps are unavailable in this fork. A successful dispatch is not a completed
review. Preserve their actual results; never create substitute passing statuses
under their names or change their original gate scripts to accept missing proof.

Before landing a product change:

1. Complete two independent code reviews bound to the exact candidate commit.
   Keep reviewer identity, scope, findings, and dispositions separate. A review
   by the author, repository administration, or a CODEOWNERS entry is not an
   independent approval. Any GitHub-enforced review remains required.
2. Pass every applicable functional and security check. Security Review remains
   enforced for every pull request, using the existing dependency, sensitive
   path, authorization, and combined-status logic. Failed security audits,
   unavailable runners, cancelled jobs, and skipped checks are not passing
   evidence. Explicitly classify checks that require an upstream-only service;
   do not extend that classification to real product or security failures.
3. Pass the complete Linux installation and offline restoration qualification
   for changes that ship the runtime package. Bind the package, dependency
   graph, supported runtime proofs, and restore artifact digests to that source.
4. Re-read the pull request head, base, checks, review findings, and branch
   rules. Submit an ordinary merge with the reviewed head precondition. Do not
   use admin bypass, invent a successful check, or merge a replacement head
   under an earlier review. Verify the actual landed commit and tree afterward.

Security ownership is mapped to the fork owner because the upstream SecOps
team cannot administer this repository. The protected path list and security
classifications are unchanged. An owner who authored a change still needs both
independent reviews. Upstream release ownership remains unchanged; this
maintenance contract grants no release authority.

Security Review reads trusted policy from the default branch. The upstream
rollout reference points to a pull request that does not exist in this fork;
removing that reference selects the existing `enforced` mode immediately,
without an inactive or grandfathered interval. The initial trusted-policy
installation requires an explicit, narrowly scoped bootstrap disposition with
its own reviewed commit and validation. A broken bootstrap check is retained as
an infrastructure failure, never rewritten as a passed review. Subsequent
product pull requests must obtain the actual enforced review from that trusted
default branch before landing.
